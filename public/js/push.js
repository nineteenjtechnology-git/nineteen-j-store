// Nineteen J Store - notifications Web Push (côté visiteur)
// Gratuit et natif : abonnement via le navigateur, enregistré dans Supabase (table fermée, via RPC).
// La permission n'est demandée QUE sur clic de l'utilisateur (jamais à l'arrivée sur le site).
import { supabase } from './supabase-config.js';
import { getDeviceId } from './device-id.js';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// navigator.serviceWorker.ready ne se résout jamais sans SW enregistré : on borne l'attente.
async function swReady() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), 6000))
  ]);
}

async function register(sub) {
  const json = sub.toJSON();
  const { error } = await supabase.rpc('register_push_subscription', {
    endpoint_input: json.endpoint,
    p256dh_input: json.keys?.p256dh,
    auth_input: json.keys?.auth,
    device_input: getDeviceId()
  });
  if (error) throw error;
}

async function createSubscription(reg) {
  const { data: key, error } = await supabase.rpc('push_public_key');
  if (error || !key) throw new Error('push-not-configured');
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
}

// 'unsupported' | 'denied' | 'subscribed' | 'idle'
export async function getPushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await swReady();
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'subscribed' : 'idle';
  } catch {
    return 'idle';
  }
}

export async function subscribePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'idle';
  const reg = await swReady();
  const sub = (await reg.pushManager.getSubscription()) || (await createSubscription(reg));
  await register(sub);
  return 'subscribed';
}

export async function unsubscribePush() {
  const reg = await swReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  // Si cet appel échoue, la ligne sera supprimée automatiquement au prochain envoi (réponse 410 du service push).
  try {
    await supabase.rpc('unregister_push_subscription', { endpoint_input: endpoint });
  } catch {
    /* voir commentaire ci-dessus */
  }
}

// Silencieux : rafraîchit l'abonnement déjà autorisé (clés renouvelées, abonnement expiré…).
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await swReady();
    const sub = (await reg.pushManager.getSubscription()) || (await createSubscription(reg));
    await register(sub);
  } catch {
    /* pas bloquant */
  }
}

function notify(message) {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '60',
    maxWidth: '90vw', padding: '12px 16px', borderRadius: '12px', fontSize: '14px',
    background: 'var(--surface, #1c1815)', color: 'var(--text, #fff)', border: '1px solid var(--accent, #f59e0b)',
    boxShadow: '0 10px 30px rgba(0,0,0,.4)'
  });
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Bouton cloche de l'en-tête : caché si le navigateur ne gère pas le push (ex. Safari iPhone hors écran d'accueil).
export async function initPushButton() {
  const btn = document.getElementById('push-toggle');
  if (!btn || !pushSupported()) return;
  btn.classList.remove('hidden');

  const refresh = async () => {
    const state = await getPushState();
    btn.setAttribute('aria-pressed', String(state === 'subscribed'));
    btn.style.color = state === 'subscribed' ? 'var(--accent)' : '';
    btn.title = state === 'subscribed' ? 'Notifications activées - cliquer pour désactiver' : 'Activer les notifications';
    btn.setAttribute('aria-label', btn.title);
    return state;
  };
  await refresh();
  syncPush();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const state = await getPushState();
      if (state === 'denied') {
        notify('Notifications bloquées : autorise-les dans les réglages du navigateur pour ce site.');
      } else if (state === 'subscribed') {
        await unsubscribePush();
        notify('Notifications désactivées.');
      } else {
        const result = await subscribePush();
        if (result === 'subscribed') notify('Notifications activées ✓ Tu seras prévenu des nouveautés.');
        else if (result === 'denied') notify('Notifications refusées. Tu peux les autoriser dans les réglages du navigateur.');
      }
    } catch (err) {
      console.error('Notifications :', err);
      notify(err?.message === 'push-not-configured'
        ? 'Les notifications ne sont pas encore disponibles. Réessaie bientôt.'
        : "Impossible d'activer les notifications pour le moment.");
    } finally {
      btn.disabled = false;
      refresh();
    }
  });
}
