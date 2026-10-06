// Nineteen J Store — envoi de notifications Web Push (gratuit, natif).
// Déployée avec verify_jwt = false : le jeton de l'admin est un JWT *Firebase* (pas un JWT Supabase),
// la vérification est donc faite ici, via la fonction SQL am_i_admin() (private.is_admin()).
//
// Actions (POST JSON) :
//   { action: "init" }                                   -> génère les clés VAPID si absentes (admin)
//   { action: "send", title, body, url?, audience }      -> envoie (admin)
//     audience : { type: "all" } | { type: "app", app_id } | { type: "endpoint", endpoint } (test)
//   { action: "run_due" }                                -> envoie les messages programmés arrivés à échéance
//     (appelée chaque minute par pg_cron ; authentifiée par l'en-tête x-cron-secret, pas par un jeton admin)
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Clé publishable (publique par nature, déjà dans le code du site) : sert uniquement à interroger am_i_admin.
const PUBLISHABLE_KEY = "sb_publishable_qOCcrFOqNBNVwAu-cWFqYw_WQBzL5uT";
const VAPID_SUBJECT = "mailto:wilfriedodessi@gmail.com";
const MAX_RECIPIENTS = 5000;
const CONCURRENCY = 25;
const MAX_LATE_MS = 6 * 60 * 60 * 1000; // un envoi programmé en retard de plus de 6 h est abandonné (promo périmée)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function isAdmin(authHeader: string | null): Promise<boolean> {
  if (!authHeader || !/^Bearer\s+\S+$/.test(authHeader)) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/am_i_admin`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, Authorization: authHeader, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function getConfig() {
  const { data, error } = await sb.from("push_config").select("public_key, private_key, subject, cron_secret").eq("id", 1).maybeSingle();
  if (error) throw error;
  return data;
}

async function initKeys() {
  const existing = await getConfig();
  if (existing) return { created: false, public_key: existing.public_key };
  const keys = webpush.generateVAPIDKeys();
  const { error } = await sb
    .from("push_config")
    .upsert({ id: 1, public_key: keys.publicKey, private_key: keys.privateKey, subject: VAPID_SUBJECT }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
  const cfg = await getConfig();
  return { created: true, public_key: cfg!.public_key };
}

type Sub = { endpoint: string; p256dh: string; auth: string };

async function loadSubscriptions(audience: any): Promise<Sub[]> {
  const cols = "endpoint, p256dh, auth";
  if (audience.type === "endpoint") {
    const { data, error } = await sb.from("push_subscriptions").select(cols).eq("endpoint", audience.endpoint);
    if (error) throw error;
    return data ?? [];
  }
  if (audience.type === "app") {
    const ids = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("app_download_events").select("device_id").eq("app_id", audience.app_id).range(from, from + 999);
      if (error) throw error;
      (data ?? []).forEach((r: any) => r.device_id && ids.add(r.device_id));
      if (!data || data.length < 1000) break;
    }
    const list = [...ids];
    const out: Sub[] = [];
    for (let i = 0; i < list.length && out.length < MAX_RECIPIENTS; i += 200) {
      const { data, error } = await sb.from("push_subscriptions").select(cols).in("device_id", list.slice(i, i + 200)).limit(1000);
      if (error) throw error;
      out.push(...(data ?? []));
    }
    return out.slice(0, MAX_RECIPIENTS);
  }
  const out: Sub[] = [];
  for (let from = 0; out.length < MAX_RECIPIENTS; from += 1000) {
    const { data, error } = await sb.from("push_subscriptions").select(cols).order("created_at").range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out.slice(0, MAX_RECIPIENTS);
}

type Audience = { type: "all" } | { type: "app"; app_id: string } | { type: "endpoint"; endpoint: string };
type Delivery = { recipients: number; sent: number; failed: number; removed: number };

// Envoie une notification à une audience, supprime les abonnements expirés et journalise l'envoi.
// Renvoie null si les clés VAPID ne sont pas encore générées.
async function deliver(m: { title: string; body: string; url: string; audience: Audience }): Promise<Delivery | null> {
  const { title, body, url, audience } = m;
  const cfg = await getConfig();
  if (!cfg) return null;
  webpush.setVapidDetails(cfg.subject, cfg.public_key, cfg.private_key);

  const subs = await loadSubscriptions(audience);
  if (!subs.length) return { recipients: 0, sent: 0, failed: 0, removed: 0 };

  const payload = JSON.stringify({ title, body, url });
  let sent = 0, failed = 0;
  const expired: string[] = [];

  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    const chunk = subs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          TTL: 60 * 60 * 24,
          urgency: "normal",
          timeout: 10000,
        })
      )
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") sent++;
      else {
        const code = (r.reason as any)?.statusCode;
        if (code === 404 || code === 410) expired.push(chunk[idx].endpoint);
        else failed++;
      }
    });
  }

  // Abonnements expirés / désinstallés : supprimés automatiquement.
  for (let i = 0; i < expired.length; i += 100) {
    await sb.from("push_subscriptions").delete().in("endpoint", expired.slice(i, i + 100));
  }

  let label = "Tous les abonnés";
  if (audience.type === "endpoint") label = "Test (admin)";
  if (audience.type === "app") {
    const { data } = await sb.from("apps").select("title").eq("id", audience.app_id).maybeSingle();
    label = `Téléchargeurs de ${data?.title ?? "une app"}`;
  }
  await sb.from("push_messages").insert({ title, body, url, audience: label, recipients: subs.length, sent, failed, removed: expired.length });
  return { recipients: subs.length, sent, failed, removed: expired.length };
}

// Clôt le traitement d'une ligne programmée. Envoi unique : statut final. Envoi répété : la fonction SQL
// reschedule_push calcule la prochaine échéance (ou clôt la série à sa date de fin), même après un échec ou un retard.
async function settle(row: any, outcome: "sent" | "failed" | "missed", result: unknown) {
  if (row.repeat_every && row.repeat_every !== "none") {
    const { error } = await sb.rpc("reschedule_push", { scheduled_id: row.id, result_input: result, sent_input: outcome === "sent" });
    if (error) console.error("reschedule_push :", error);
    return;
  }
  const patch: Record<string, unknown> = { status: outcome, result };
  if (outcome === "sent") patch.sent_at = new Date().toISOString();
  await sb.from("push_scheduled").update(patch).eq("id", row.id);
}

// Traite les messages programmés arrivés à échéance. Chaque message est « réservé » (pending -> sending)
// avant l'envoi : deux passages simultanés ne peuvent pas l'envoyer deux fois.
async function runDue() {
  let processed = 0;
  const { data: due, error } = await sb
    .from("push_scheduled")
    .select("id, title, body, url, audience_type, app_id, send_at, repeat_every")
    .eq("status", "pending")
    .lte("send_at", new Date().toISOString())
    .order("send_at")
    .limit(10);
  if (error) throw error;

  for (const row of due ?? []) {
    const { data: claimed } = await sb.from("push_scheduled").update({ status: "sending" }).eq("id", row.id).eq("status", "pending").select("id");
    if (!claimed?.length) continue;
    processed++;

    if (Date.now() - new Date(row.send_at).getTime() > MAX_LATE_MS) {
      await settle(row, "missed", { reason: "trop en retard" });
      continue;
    }
    try {
      const audience: Audience = row.audience_type === "app" ? { type: "app", app_id: row.app_id } : { type: "all" };
      const r = await deliver({ title: row.title, body: row.body, url: row.url, audience });
      if (r === null) await settle(row, "failed", { error: "clés VAPID absentes" });
      else await settle(row, "sent", r);
    } catch (err) {
      console.error("run_due :", err);
      await settle(row, "failed", { error: "erreur pendant l'envoi" });
    }
  }
  return { processed };
}

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/(?!\/)[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Méthode non autorisée." });

  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return reply(400, { error: "Requête invalide." });

    // Appel automatique de pg_cron : authentifié par le secret partagé stocké dans la base.
    if (b.action === "run_due") {
      const cfg = await getConfig();
      if (!cfg || !sameSecret(req.headers.get("x-cron-secret") ?? "", cfg.cron_secret)) {
        return reply(403, { error: "Accès refusé." });
      }
      return reply(200, await runDue());
    }

    if (!(await isAdmin(req.headers.get("Authorization")))) return reply(403, { error: "Accès réservé aux administrateurs." });

    if (b.action === "init") return reply(200, await initKeys());
    if (b.action !== "send") return reply(400, { error: "Action inconnue." });

    const title = String(b.title ?? "").trim();
    const body = String(b.body ?? "").trim();
    const url = typeof b.url === "string" && b.url ? b.url : "/";
    const audience = b.audience ?? { type: "all" };
    if (!title || title.length > 65) return reply(400, { error: "Titre requis (65 caractères max)." });
    if (!body || body.length > 180) return reply(400, { error: "Message requis (180 caractères max)." });
    if (url.length > 300 || !PATH.test(url)) return reply(400, { error: "Lien invalide (chemin du site attendu, ex. /app/detail?slug=…)." });
    if (!["all", "app", "endpoint"].includes(audience.type)) return reply(400, { error: "Audience invalide." });
    if (audience.type === "app" && !UUID.test(String(audience.app_id))) return reply(400, { error: "App invalide." });
    if (audience.type === "endpoint" && !String(audience.endpoint ?? "").startsWith("https://")) return reply(400, { error: "Abonnement invalide." });

    const result = await deliver({ title, body, url, audience });
    if (result === null) return reply(409, { error: "Les clés VAPID ne sont pas encore générées (ouvre la section Notifications du panneau admin)." });
    return reply(200, result);
  } catch (err) {
    console.error("send-push :", err);
    return reply(500, { error: "Erreur interne pendant l'envoi." });
  }
});
