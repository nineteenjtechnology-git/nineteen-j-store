// Nineteen J Store — Panneau Admin (100% statique, aucun backend)
// Lecture publique via `supabase`. Écritures via `supabaseAdmin` (token Firebase =
// JWT), autorisées par RLS (private.is_admin()) uniquement pour role='admin'.
//
// Flux volontairement en 2 temps : 1) créer/enregistrer les infos de base de
// l'app (obtient un appId stable) 2) chaque icône/capture/version s'enregistre
// IMMÉDIATEMENT en base dès l'upload réussi — plus d'état en mémoire qui peut
// se perdre si le formulaire est fermé/rouvert avant la fin.
import { supabase, SUPABASE_PROJECT_REF, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';
import { supabaseAdmin } from './supabase-admin.js';
import { auth } from './firebase-config.js';
import { watchAuthState, loginWithGoogle, logout } from './auth.js';

const screens = {
  login: document.getElementById('screen-login'),
  denied: document.getElementById('screen-denied'),
  loading: document.getElementById('screen-loading'),
  dashboard: document.getElementById('screen-dashboard')
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => el?.classList.toggle('hidden', key !== name));
}

function toast(message, variant = 'default') {
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  const color = variant === 'error' ? 'border-[var(--danger)]' : 'border-[var(--accent)]';
  el.className = `toast surface ${color} border rounded-lg px-4 py-3 text-sm shadow-lg`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function pathFromPublicUrl(bucket, url) {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

function formatFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// Alignées sur les limites réellement configurées sur les buckets Supabase.
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_BINARY_SIZE = 50 * 1024 * 1024;

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Auth (Google uniquement, voir audit M5) ----------
document.getElementById('google-login-btn')?.addEventListener('click', async () => {
  const errEl = document.getElementById('login-error');
  errEl?.classList.add('hidden');
  try {
    await loginWithGoogle();
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Connexion impossible pour le moment.';
      errEl.classList.remove('hidden');
    }
  }
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
  await logout();
});
document.getElementById('logout-btn-denied')?.addEventListener('click', async () => {
  await logout();
});

async function ensureProfileAndGetRole(user) {
  const { data: existing } = await supabaseAdmin.from('profiles').select('*').eq('firebase_uid', user.uid).maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabaseAdmin
    .from('profiles')
    .insert({ firebase_uid: user.uid, email: user.email || '', role: 'user' })
    .select()
    .single();
  if (error) throw error;
  return created;
}

watchAuthState(async (user) => {
  if (!user) {
    showScreen('login');
    return;
  }
  showScreen('loading');
  try {
    const profile = await ensureProfileAndGetRole(user);
    if (profile?.role !== 'admin') {
      showScreen('denied');
      return;
    }
    document.getElementById('admin-email').textContent = user.email || '';
    showScreen('dashboard');
    await Promise.all([loadStats(), loadCategories(), loadApps()]);
    loadAnalytics().catch((err) => console.error('Audience :', err));
  } catch (err) {
    console.error(err);
    showScreen('denied');
  }
});

// ---------- Stats ----------
async function loadStats() {
  const [{ count: appsCount }, { count: catCount }, { data: apps }] = await Promise.all([
    supabaseAdmin.from('apps').select('id', { count: 'exact', head: true }),
    supabase.from('categories').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('apps').select('download_count')
  ]);
  const totalDownloads = (apps || []).reduce((sum, a) => sum + (a.download_count || 0), 0);
  document.getElementById('stat-apps').textContent = appsCount ?? 0;
  document.getElementById('stat-categories').textContent = catCount ?? 0;
  document.getElementById('stat-downloads').textContent = totalDownloads.toLocaleString('fr-FR');
}

// ---------- Audience (téléchargements + sondage) ----------
const SURVEY_LABELS = {
  eleve: 'Élève', etudiant: 'Étudiant(e)', enseignant: 'Enseignant(e)', professionnel: 'Professionnel(le)', autre: 'Autre',
  etudes: 'Études', travail: 'Travail', loisirs: 'Loisirs',
  whatsapp: 'WhatsApp', facebook: 'Facebook', tiktok_instagram: 'TikTok / Instagram', ami: 'Un(e) ami(e)'
};

function barList(title, rows, { labels = {}, emptyText = 'Pas encore de données' } = {}) {
  const list = rows || [];
  const max = Math.max(1, ...list.map((r) => r.n));
  const body = list.length
    ? list
        .map(
          (r) => `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(labels[r.k] || r.k)}</span>
          <span class="bar-num">${r.n}</span>
          <span class="bar-track"><span style="width:${Math.round((r.n / max) * 100)}%"></span></span>
        </div>`
        )
        .join('')
    : `<p class="text-xs text-[var(--muted)] mt-2">${emptyText}</p>`;
  return `<div class="surface rounded-xl p-4"><p class="font-semibold text-sm">${title}</p>${body}</div>`;
}

async function loadAnalytics() {
  const root = document.getElementById('analytics-root');
  const days = Number(document.getElementById('analytics-days')?.value) || 30;
  root.textContent = 'Chargement…';
  const { data, error } = await supabaseAdmin.rpc('admin_analytics', { days_input: days });
  if (error) {
    root.textContent = 'Impossible de charger les statistiques.';
    throw error;
  }
  const survey = data.survey || {};
  root.innerHTML = `
    <div class="stat-grid" style="margin-bottom:1rem">
      <div class="surface rounded-xl p-4"><p class="text-xs text-[var(--muted)]">Téléchargements (${data.days} j)</p><p class="font-display text-2xl font-bold mt-1">${Number(data.downloads).toLocaleString('fr-FR')}</p></div>
      <div class="surface rounded-xl p-4"><p class="text-xs text-[var(--muted)]">Appareils distincts</p><p class="font-display text-2xl font-bold mt-1">${Number(data.devices).toLocaleString('fr-FR')}</p></div>
      <div class="surface rounded-xl p-4"><p class="text-xs text-[var(--muted)]">Réponses au sondage (total)</p><p class="font-display text-2xl font-bold mt-1">${Number(survey.total || 0).toLocaleString('fr-FR')}</p></div>
    </div>
    <div class="stat-grid">
      ${barList('D’où viennent-ils ? (source du lien)', data.by_source)}
      ${barList('Système', data.by_os)}
      ${barList('Navigateur', data.by_browser)}
      ${barList('Modèle d’appareil', data.by_model, { emptyText: 'Disponible surtout sur Chrome Android' })}
      ${barList('Langue', data.by_lang)}
      ${barList('Connexion', data.by_network, { emptyText: 'Non communiquée par le navigateur' })}
      ${barList('Sondage : ils sont…', survey.statut, { labels: SURVEY_LABELS })}
      ${barList('Sondage : ils téléchargent pour…', survey.usage, { labels: SURVEY_LABELS })}
      ${barList('Sondage : ils ont connu le store via…', survey.decouverte, { labels: SURVEY_LABELS })}
      ${barList('Sondage : villes', survey.villes)}
    </div>`;
}

document.getElementById('analytics-days')?.addEventListener('change', () => {
  loadAnalytics().catch((err) => console.error('Audience :', err));
});

// ---------- Categories ----------
let categoriesCache = [];

async function loadCategories() {
  const { data } = await supabase.from('categories').select('*').order('display_order').order('name');
  categoriesCache = data || [];
  const select = document.getElementById('app-category');
  select.innerHTML = categoriesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  const list = document.getElementById('categories-list');
  list.innerHTML = categoriesCache
    .map(
      (c, i) => `<li class="flex items-center justify-between surface-2 rounded-lg px-3 py-2 text-sm">
        <span>${escapeHtml(c.name)}</span>
        <span class="flex items-center gap-2">
          <button class="btn-ghost px-1.5 py-0.5 text-xs rounded" data-move-up="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
          <button class="btn-ghost px-1.5 py-0.5 text-xs rounded" data-move-down="${c.id}" ${i === categoriesCache.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
          <button class="text-[var(--danger)] hover:underline" data-delete-category="${c.id}">Supprimer</button>
        </span>
      </li>`
    )
    .join('') || '<li class="text-[var(--muted)] text-sm">Aucune catégorie.</li>';
}

document.getElementById('category-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('category-name').value.trim();
  const icon = document.getElementById('category-icon').value.trim() || 'grid';
  if (!name) return;
  const { error } = await supabaseAdmin
    .from('categories')
    .insert({ name, slug: slugify(name), icon_name: icon, display_order: categoriesCache.length });
  if (error) return toast(error.message, 'error');
  document.getElementById('category-form').reset();
  toast('Catégorie créée.');
  await loadCategories();
});

document.getElementById('categories-list')?.addEventListener('click', async (e) => {
  const deleteBtn = e.target.closest('[data-delete-category]');
  const upBtn = e.target.closest('[data-move-up]');
  const downBtn = e.target.closest('[data-move-down]');

  if (deleteBtn) {
    if (!confirm('Supprimer cette catégorie ?')) return;
    const { error } = await supabaseAdmin.from('categories').delete().eq('id', deleteBtn.dataset.deleteCategory);
    if (error) return toast(error.message, 'error');
    toast('Catégorie supprimée.');
    await loadCategories();
  }

  if (upBtn || downBtn) {
    const id = (upBtn || downBtn).dataset.moveUp || (upBtn || downBtn).dataset.moveDown;
    const idx = categoriesCache.findIndex((c) => c.id === id);
    const swapIdx = upBtn ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= categoriesCache.length) return;
    const a = categoriesCache[idx];
    const b = categoriesCache[swapIdx];
    await Promise.all([
      supabaseAdmin.from('categories').update({ display_order: b.display_order }).eq('id', a.id),
      supabaseAdmin.from('categories').update({ display_order: a.display_order }).eq('id', b.id)
    ]);
    await loadCategories();
  }
});

// ---------- Apps table ----------
let appsCache = [];

async function loadApps() {
  const { data } = await supabaseAdmin.from('apps').select('*').order('created_at', { ascending: false });
  appsCache = data || [];
  const tbody = document.getElementById('apps-table-body');
  tbody.innerHTML = appsCache
    .map(
      (a) => `<tr>
        <td class="py-2 pr-4">
          <div class="flex items-center gap-2">
            <img src="${a.icon_url || '/assets/icons/icon-192.png'}" class="w-8 h-8 rounded-md object-cover" alt="" />
            <span class="font-medium">${escapeHtml(a.title)}</span>
          </div>
        </td>
        <td class="py-2 pr-4">${a.platform}</td>
        <td class="py-2 pr-4">
          <button class="btn-ghost px-2 py-1 text-xs rounded" data-toggle-status="${a.id}" data-status="${a.status}">${a.status === 'published' ? 'Publié · dépublier' : 'Brouillon · publier'}</button>
        </td>
        <td class="py-2 pr-4">${a.download_count}</td>
        <td class="py-2 pr-4">
          <button class="btn-ghost px-2 py-1 text-xs rounded" data-feature="${a.id}" data-current="${a.featured}">${a.featured ? '★ En avant' : 'Mettre en avant'}</button>
        </td>
        <td class="py-2 pr-4 text-right space-x-2">
          <button class="btn-ghost px-2 py-1 text-xs rounded" data-edit="${a.id}">Gérer</button>
          <button class="text-[var(--danger)] text-xs hover:underline" data-delete="${a.id}">Supprimer</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="6" class="py-6 text-center text-[var(--muted)]">Aucune application publiée.</td></tr>';
}

document.getElementById('apps-table-body')?.addEventListener('click', async (e) => {
  const featureBtn = e.target.closest('[data-feature]');
  const statusBtn = e.target.closest('[data-toggle-status]');
  const editBtn = e.target.closest('[data-edit]');
  const deleteBtn = e.target.closest('[data-delete]');

  if (statusBtn) {
    const next = statusBtn.dataset.status === 'published' ? 'draft' : 'published';
    const { error } = await supabaseAdmin.from('apps').update({ status: next }).eq('id', statusBtn.dataset.toggleStatus);
    if (error) return toast(error.message, 'error');
    toast(next === 'published' ? 'Application publiée.' : 'Application repassée en brouillon.');
    await Promise.all([loadApps(), loadStats()]);
  }

  if (featureBtn) {
    const id = featureBtn.dataset.feature;
    const current = featureBtn.dataset.current === 'true';
    const { error } = await supabaseAdmin.from('apps').update({ featured: !current }).eq('id', id);
    if (error) return toast(error.message, 'error');
    await Promise.all([loadApps(), loadStats()]);
  }

  if (editBtn) openAppForm(appsCache.find((a) => a.id === editBtn.dataset.edit));

  if (deleteBtn) {
    if (!confirm('Supprimer définitivement cette application ?')) return;
    const { error } = await supabaseAdmin.from('apps').delete().eq('id', deleteBtn.dataset.delete);
    if (error) return toast(error.message, 'error');
    toast('Application supprimée.');
    await Promise.all([loadApps(), loadStats()]);
  }
});

// ---------- Formulaire : infos de base ----------
const baseForm = document.getElementById('app-base-form');
const appFormTitle = document.getElementById('app-form-title');
const appFormHint = document.getElementById('app-form-hint');
const mediaSection = document.getElementById('media-section');
let editingAppId = null;

document.getElementById('new-app-btn')?.addEventListener('click', () => openAppForm(null));
document.getElementById('app-form-cancel')?.addEventListener('click', () => closeAppForm());

function openAppForm(app) {
  editingAppId = app?.id || null;
  baseForm.reset();
  document.getElementById('icon-preview').src = app?.icon_url || '/assets/icons/icon-192.png';

  if (app) {
    appFormTitle.textContent = `Gérer « ${app.title} »`;
    appFormHint.textContent = "Modifie les infos de base ci-dessous si besoin, gère l'icône, les captures et les versions plus bas.";
    document.getElementById('app-title').value = app.title;
    document.getElementById('app-short-desc').value = app.short_description;
    document.getElementById('app-full-desc').value = app.full_description || '';
    document.getElementById('app-category').value = app.category_id || '';
    document.getElementById('app-platform').value = app.platform;
    document.getElementById('app-developer').value = app.developer_name;
    document.getElementById('app-website').value = app.website_url || '';
    document.getElementById('app-status').value = app.status || 'draft';
    document.getElementById('app-base-submit').textContent = 'Enregistrer les modifications';
    mediaSection.classList.remove('hidden');
    loadScreenshotsGallery(app.id);
    loadVersionsList(app.id);
    loadCommentsAdmin(app.id);
  } else {
    appFormTitle.textContent = 'Nouvelle application';
    appFormHint.textContent = "1. Enregistre les informations de base. 2. L'icône, les captures et les versions apparaissent ensuite et s'enregistrent immédiatement, une par une.";
    document.getElementById('app-base-submit').textContent = "Créer l'application";
    mediaSection.classList.add('hidden');
  }

  document.getElementById('app-form-panel').classList.remove('hidden');
  document.getElementById('app-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeAppForm() {
  document.getElementById('app-form-panel').classList.add('hidden');
  editingAppId = null;
}

baseForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = document.getElementById('app-base-submit');
  submitBtn.disabled = true;

  const payload = {
    title: document.getElementById('app-title').value.trim(),
    short_description: document.getElementById('app-short-desc').value.trim(),
    full_description: document.getElementById('app-full-desc').value.trim(),
    category_id: document.getElementById('app-category').value || null,
    platform: document.getElementById('app-platform').value,
    developer_name: document.getElementById('app-developer').value.trim() || 'Nineteen J Games',
    website_url: document.getElementById('app-website').value.trim() || null,
    status: document.getElementById('app-status').value
  };

  try {
    if (editingAppId) {
      const { error } = await supabaseAdmin.from('apps').update(payload).eq('id', editingAppId);
      if (error) throw error;
      toast('Informations mises à jour.');
    } else {
      payload.slug = slugify(payload.title) + '-' + Math.random().toString(36).slice(2, 6);
      const { data, error } = await supabaseAdmin.from('apps').insert(payload).select().single();
      if (error) throw error;
      editingAppId = data.id;
      appFormTitle.textContent = `Gérer « ${data.title} »`;
      appFormHint.textContent = 'Application créée. Ajoute maintenant une icône, des captures et au moins une version pour la rendre téléchargeable.';
      submitBtn.textContent = 'Enregistrer les modifications';
      mediaSection.classList.remove('hidden');
      loadScreenshotsGallery(editingAppId);
      loadVersionsList(editingAppId);
      toast('Application créée — ajoute maintenant ses médias.');
    }
    await Promise.all([loadApps(), loadStats()]);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// ---------- Upload générique ----------
// On utilise la méthode officielle uploadToSignedUrl() plutôt qu'un fetch/XHR
// manuel vers l'URL signée : plus fiable selon navigateurs/réseaux (l'ancienne
// approche déclenchait des "erreurs réseau" intermittentes non reproductibles).
// Contrepartie : pas de progression en %, juste un statut texte.
async function uploadToStorage(bucket, file, onStatus) {
  const ext = file.name.split('.').pop();
  const path = `${crypto.randomUUID()}.${ext}`;

  const { data: signed, error: signErr } = await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(path);
  if (signErr) throw new Error(`Impossible de préparer l'upload : ${signErr.message}`);

  onStatus?.('Envoi en cours…');
  const { error: uploadErr } = await supabaseAdmin.storage.from(bucket).uploadToSignedUrl(signed.path, signed.token, file);
  if (uploadErr) throw new Error(`Échec de l'upload : ${uploadErr.message}`);
  onStatus?.('Terminé.');

  const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(signed.path);
  return { path: signed.path, publicUrl: pub.publicUrl };
}

// ---------- Upload résumable (TUS) pour les gros fichiers (APK/ZIP) ----------
// Recommandation officielle Supabase au-delà de 6 Mo : découpe en blocs de 6 Mo,
// reprend automatiquement en cas de coupure réseau au lieu de tout ré-envoyer.
// C'est ce qui manquait pour les APK sur connexion instable (uploadToSignedUrl
// envoie le fichier en un seul bloc, sans retry).
async function uploadBinaryResumable(file, onProgress) {
  if (!window.tus) throw new Error('Bibliothèque d\u2019upload indisponible (tus-js-client non chargé).');

  const ext = file.name.split('.').pop();
  const path = `${crypto.randomUUID()}.${ext}`;

  // getIdToken() peut échouer ponctuellement si le service Firebase Auth répond
  // 503 (vu en pratique) — une tentative suffit généralement à passer.
  let idToken;
  try {
    idToken = await auth.currentUser.getIdToken();
  } catch (_) {
    await new Promise((r) => setTimeout(r, 1500));
    idToken = await auth.currentUser.getIdToken(true);
  }

  await new Promise((resolve, reject) => {
    const upload = new window.tus.Upload(file, {
      endpoint: `https://${SUPABASE_PROJECT_REF}.storage.supabase.co/storage/v1/upload/resumable`,
      // Plus de tentatives + délais plus longs : les erreurs réseau bas niveau
      // (ex. ERR_HTTP2_PROTOCOL_ERROR causé par un antivirus/proxy qui inspecte le
      // HTTPS) sont souvent transitoires bloc par bloc — retenter suffit généralement.
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
      headers: {
        authorization: `Bearer ${idToken}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'x-upsert': 'true'
      },
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: false, // voir note ci-dessous
      chunkSize: 6 * 1024 * 1024, // imposé par Supabase, ne pas modifier
      metadata: {
        bucketName: 'app-binaries',
        objectName: path,
        contentType: file.type || 'application/octet-stream',
        cacheControl: '3600'
      },
      onError: (err) => {
        const msg = String(err?.message || err);
        const hint = /HTTP2|NETWORK|Failed to fetch/i.test(msg)
          ? ' Cause probable : antivirus/proxy qui inspecte le HTTPS, ou réseau instable. Réessaie, si possible sur un autre réseau ou navigateur.'
          : '';
        reject(new Error(`Échec de l'upload après plusieurs tentatives : ${msg}.${hint}`));
      },
      onProgress: (uploaded, total) => onProgress?.(Math.round((uploaded / total) * 100)),
      onSuccess: () => resolve()
    });

    // PAS de findPreviousUploads()/resumeFromPreviousUpload() ici : si un essai
    // précédent sur le MÊME fichier (même nom+taille+date) avait été interrompu,
    // ça reprenait l'upload stocké sous l'ANCIEN nom aléatoire (celui généré lors
    // de la tentative précédente) tout en enregistrant ce nouveau `path` en base —
    // lien mort garanti (vécu en pratique : fichier réel sous un nom, base sous un
    // autre). On démarre donc toujours un upload neuf ; la résilience réseau reste
    // assurée par retryDelays ci-dessus (retry interne au même upload en cours).
    upload.start();
  });

  const { data: pub } = supabaseAdmin.storage.from('app-binaries').getPublicUrl(path);
  return { path, publicUrl: pub.publicUrl };
}

// ---------- Icône (sauvegarde immédiate) ----------
document.getElementById('icon-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !editingAppId) return;
  if (file.size > MAX_IMAGE_SIZE) {
    toast(`Icône trop lourde (${formatFileSize(file.size)}) — max ${formatFileSize(MAX_IMAGE_SIZE)}.`, 'error');
    e.target.value = '';
    return;
  }
  try {
    const { publicUrl } = await uploadToStorage('app-icons', file);
    const { error } = await supabaseAdmin.from('apps').update({ icon_url: publicUrl }).eq('id', editingAppId);
    if (error) throw error;
    document.getElementById('icon-preview').src = publicUrl;
    toast('Icône mise à jour.');
    await loadApps();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------- Captures d'écran (sauvegarde immédiate + galerie) ----------
async function loadScreenshotsGallery(appId) {
  const { data } = await supabaseAdmin.from('app_screenshots').select('*').eq('app_id', appId).order('display_order');
  renderScreenshotsGallery(data || []);
}

function renderScreenshotsGallery(shots) {
  const gallery = document.getElementById('screenshots-gallery');
  gallery.innerHTML = shots
    .map(
      (s) => `<li class="relative">
        <img src="${s.image_url}" class="w-24 h-24 object-cover rounded-lg border border-[var(--border)]" alt="" />
        <button class="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[var(--danger)] text-white text-xs" data-delete-screenshot="${s.id}" data-url="${s.image_url}" aria-label="Supprimer">✕</button>
      </li>`
    )
    .join('') || '<li class="text-sm text-[var(--muted)]">Aucune capture pour le moment.</li>';
}

document.getElementById('screenshots-input')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!editingAppId || !files.length) return;
  const progressEl = document.getElementById('screenshots-progress');

  const { count } = await supabaseAdmin
    .from('app_screenshots')
    .select('id', { count: 'exact', head: true })
    .eq('app_id', editingAppId);
  let displayOrder = count || 0;
  let ok = 0;

  for (const file of files) {
    if (file.size > MAX_IMAGE_SIZE) {
      toast(`${file.name} trop lourd (${formatFileSize(file.size)}) — max ${formatFileSize(MAX_IMAGE_SIZE)}, ignoré.`, 'error');
      continue;
    }
    progressEl.textContent = `Envoi de ${file.name}…`;
    try {
      const { publicUrl } = await uploadToStorage('app-screenshots', file);
      const { error } = await supabaseAdmin
        .from('app_screenshots')
        .insert({ app_id: editingAppId, image_url: publicUrl, display_order: displayOrder });
      if (error) throw error;
      displayOrder += 1;
      ok += 1;
    } catch (err) {
      toast(`${file.name} : ${err.message}`, 'error');
    }
  }
  progressEl.textContent = ok ? `${ok} capture(s) enregistrée(s).` : '';
  e.target.value = '';
  await loadScreenshotsGallery(editingAppId);
});

document.getElementById('screenshots-gallery')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-screenshot]');
  if (!btn) return;
  const path = pathFromPublicUrl('app-screenshots', btn.dataset.url);
  await supabaseAdmin.from('app_screenshots').delete().eq('id', btn.dataset.deleteScreenshot);
  if (path) await supabaseAdmin.storage.from('app-screenshots').remove([path]);
  await loadScreenshotsGallery(editingAppId);
});

// ---------- Versions (sauvegarde immédiate + liste) ----------
async function loadVersionsList(appId) {
  const { data } = await supabaseAdmin.from('app_versions').select('*').eq('app_id', appId).order('created_at', { ascending: false });
  renderVersionsList(data || []);
}

function renderVersionsList(versions) {
  const list = document.getElementById('versions-list');
  list.innerHTML = versions
    .map(
      (v, i) => `<li class="flex items-center justify-between surface-2 rounded-lg px-3 py-2">
        <div>
          <span class="font-medium">${escapeHtml(v.version_number)}</span>
          ${i === 0 ? '<span class="text-xs text-[var(--accent)] ml-2">actuelle</span>' : ''}
          <span class="text-[var(--muted)] ml-2">${formatDate(v.created_at)}</span>
          ${!v.file_url && !v.external_url ? '<span class="text-xs text-[var(--danger)] ml-2">aucun fichier/URL — non téléchargeable</span>' : ''}
        </div>
        <button class="text-[var(--danger)] text-xs hover:underline" data-delete-version="${v.id}" data-file="${v.file_url || ''}">Supprimer</button>
      </li>`
    )
    .join('') || '<li class="text-sm text-[var(--muted)]">Aucune version publiée — l\'app n\'est pas encore téléchargeable.</li>';
}

document.getElementById('versions-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-version]');
  if (!btn) return;
  if (!confirm('Supprimer cette version ?')) return;
  const path = btn.dataset.file ? pathFromPublicUrl('app-binaries', btn.dataset.file) : null;
  await supabaseAdmin.from('app_versions').delete().eq('id', btn.dataset.deleteVersion);
  if (path) await supabaseAdmin.storage.from('app-binaries').remove([path]);
  await loadVersionsList(editingAppId);
});

document.getElementById('binary-input')?.addEventListener('change', (e) => {
  document.getElementById('binary-name').textContent = e.target.files[0]?.name || '';
});

const versionForm = document.getElementById('version-form');
versionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingAppId) return;

  const versionNumber = document.getElementById('app-version-number').value.trim();
  const externalUrl = document.getElementById('app-external-url').value.trim() || null;
  const changelog = document.getElementById('app-changelog').value.trim();
  const binaryFile = document.getElementById('binary-input').files[0] || null;

  if (!versionNumber) return toast('Le numéro de version est requis.', 'error');
  if (binaryFile && binaryFile.size > MAX_BINARY_SIZE) {
    return toast(`Fichier trop lourd (${formatFileSize(binaryFile.size)}) — max ${formatFileSize(MAX_BINARY_SIZE)}.`, 'error');
  }

  const submitBtn = document.getElementById('version-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Enregistrement…';

  try {
    let fileUrl = null;
    let fileSize = null;

    if (binaryFile) {
      const progressWrap = document.getElementById('binary-progress-wrap');
      const progressBar = document.getElementById('binary-progress-bar');
      const progressText = document.getElementById('binary-progress-text');
      progressWrap.classList.remove('hidden');
      progressText.textContent = 'Préparation…';
      const { publicUrl } = await uploadBinaryResumable(binaryFile, (pct) => {
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `${pct}% — reprise automatique en cas de coupure`;
      });
      fileUrl = publicUrl;
      fileSize = binaryFile.size;
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
    }

    const { error } = await supabaseAdmin.from('app_versions').insert({
      app_id: editingAppId,
      version_number: versionNumber,
      changelog,
      file_url: fileUrl,
      external_url: externalUrl,
      file_size: fileSize,
      is_current: true
    });
    if (error) throw error;

    toast('Version ajoutée.');
    versionForm.reset();
    document.getElementById('binary-name').textContent = '';
    await loadVersionsList(editingAppId);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Ajouter cette version';
  }
});

// ---------- Avis & réponses admin ----------
function timeAgoShort(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return "aujourd'hui";
  if (days === 1) return 'hier';
  return formatDate(iso);
}

async function loadCommentsAdmin(appId) {
  const { data } = await supabaseAdmin.from('app_comments').select('*').eq('app_id', appId).order('created_at', { ascending: false });
  renderCommentsAdmin(data || []);
}

function renderCommentsAdmin(comments) {
  const list = document.getElementById('comments-admin-list');
  list.innerHTML = comments
    .map(
      (c) => `<li class="surface-2 rounded-lg p-3" data-comment-id="${c.id}">
        <div class="flex items-center justify-between mb-1">
          <span class="font-medium text-sm">${escapeHtml(c.author_name)}</span>
          <div class="flex items-center gap-2">
            <span class="text-xs text-[var(--muted)]">${timeAgoShort(c.created_at)}</span>
            <button class="text-[var(--danger)] text-xs hover:underline" data-delete-comment="${c.id}">Supprimer</button>
          </div>
        </div>
        <p class="text-sm text-[var(--muted)] mb-2">${escapeHtml(c.body)}</p>
        ${c.admin_reply
          ? `<div class="border-l-2 pl-3 mb-2" style="border-color:var(--accent)">
               <p class="text-xs text-[var(--accent)] font-medium mb-0.5">Ta réponse</p>
               <p class="text-sm">${escapeHtml(c.admin_reply)}</p>
             </div>`
          : ''}
        <details class="text-sm">
          <summary class="text-[var(--accent)] cursor-pointer">${c.admin_reply ? 'Modifier la réponse' : 'Répondre'}</summary>
          <form class="reply-form mt-2 flex gap-2" data-app-comment-id="${c.id}">
            <input class="reply-input flex-1 px-2 py-1.5 text-sm" maxlength="1000" placeholder="Ta réponse…" value="${escapeHtml(c.admin_reply || '')}" />
            <button type="submit" class="btn-primary px-3 py-1.5 rounded-lg text-xs shrink-0">Envoyer</button>
          </form>
        </details>
      </li>`
    )
    .join('') || '<li class="text-sm text-[var(--muted)]">Aucun avis pour le moment.</li>';
}

document.getElementById('comments-admin-list')?.addEventListener('submit', async (e) => {
  const form = e.target.closest('.reply-form');
  if (!form) return;
  e.preventDefault();
  const commentId = form.dataset.appCommentId;
  const body = form.querySelector('.reply-input').value.trim();
  if (!body) return;
  const { error } = await supabaseAdmin
    .from('app_comments')
    .update({ admin_reply: body, admin_reply_at: new Date().toISOString() })
    .eq('id', commentId);
  if (error) return toast(error.message, 'error');
  toast('Réponse publiée.');
  await loadCommentsAdmin(editingAppId);
});

document.getElementById('comments-admin-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-comment]');
  if (!btn) return;
  if (!confirm('Supprimer cet avis ?')) return;
  const { error } = await supabaseAdmin.from('app_comments').delete().eq('id', btn.dataset.deleteComment);
  if (error) return toast(error.message, 'error');
  toast('Avis supprimé.');
  await loadCommentsAdmin(editingAppId);
});

// Drag & drop générique pour les zones d'upload
document.querySelectorAll('.dropzone').forEach((zone) => {
  const input = zone.querySelector('input[type="file"]');
  ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((evt) => zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('drag-over'); }));
  zone.addEventListener('drop', (e) => {
    if (!input) return;
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change'));
  });
});
