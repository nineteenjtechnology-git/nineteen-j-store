// Nineteen J Store - page de détail d'une application
import { supabase } from './supabase-config.js';
import { supabaseAuthed } from './supabase-authed.js';
import { registerServiceWorker } from './pwa-install.js';
import { getDeviceId } from './device-id.js';
import { getSource, getClientMeta } from './tracking.js';
import { maybeAskSurvey } from './survey.js';
import { auth, googleProvider, onAuthStateChanged, signInWithPopup, signOut } from './firebase-config.js';

registerServiceWorker();

const PLATFORM_LABELS = { android: 'Android', ios: 'iOS', web: 'Web', cross_platform: 'Multiplateforme' };
const params = new URLSearchParams(location.search);
const slug = params.get('slug');

const root = document.getElementById('detail-root');
const notFound = document.getElementById('not-found');

let currentApp = null;
let currentUser = null;

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(bytes) {
  if (!bytes) return '-';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'à l\u2019instant';
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDate(iso);
}

async function loadApp() {
  if (!slug) return showNotFound();

  const { data: app, error } = await supabase.from('apps').select('*').eq('slug', slug).single();
  if (error || !app) return showNotFound();
  currentApp = app;

  const [{ data: versions }, { data: screenshots }, { data: comments }, myRating] = await Promise.all([
    supabase.from('app_versions').select('*').eq('app_id', app.id).order('created_at', { ascending: false }),
    supabase.from('app_screenshots').select('*').eq('app_id', app.id).order('display_order'),
    supabase.from('app_comments').select('*').eq('app_id', app.id).order('created_at', { ascending: false }),
    supabase.rpc('get_my_rating', { app_id_input: app.id, device_id_input: getDeviceId() })
  ]);

  render(app, versions?.[0], versions || [], screenshots || [], comments || [], myRating.data || 0);
  document.title = `${app.title} - Nineteen J Store`;

  // L'état de connexion n'affecte que la section commentaires - on ne la
  // (re)dessine qu'elle, pour ne pas perdre le reste au moindre changement d'auth.
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    renderCommentForm();
  });
}

function showNotFound() {
  root.classList.add('hidden');
  notFound.classList.remove('hidden');
}

function handleDownloadClick(app, current) {
  const target = current?.file_url || current?.external_url;
  if (!target) return;

  // window.open() doit rester synchrone, dans le prolongement direct du clic -
  // un `await` avant (ex. attendre la réponse du RPC) fait perdre le geste
  // utilisateur aux yeux du navigateur, qui peut alors bloquer le popup
  // silencieusement (symptôme observé : "rien ne se passe" / compteur figé).
  if (current?.file_url) {
    // Force un nom de fichier lisible (ex. "mon-app-v1.0.apk") au lieu du nom
    // UUID interne au Storage, via le paramètre natif ?download= de Supabase.
    const ext = current.file_url.split('.').pop().split('?')[0];
    const filename = `${app.slug}-${current.version_number}.${ext}`.replace(/[^a-z0-9._-]+/gi, '-');
    const url = new URL(current.file_url);
    url.searchParams.set('download', filename);
    window.open(url.toString(), '_blank', 'noopener');
  } else {
    window.open(target, '_blank', 'noopener');
  }

  // Le comptage se fait ensuite, en arrière-plan - un éventuel échec ou une
  // lenteur réseau ne doit jamais retarder ni bloquer le téléchargement lui-même.
  trackDownload(app);

  // Sondage général (facultatif), proposé après le démarrage du téléchargement.
  maybeAskSurvey(app);
}

async function trackDownload(app) {
  try {
    // Les infos techniques sont facultatives : on n'attend pas plus de 800 ms.
    const meta = await Promise.race([getClientMeta(), new Promise((resolve) => setTimeout(() => resolve(null), 800))]);
    const { data: total, error } = await supabase.rpc('increment_download_count', {
      app_id_input: app.id,
      device_id_input: getDeviceId(),
      source_input: getSource(),
      meta_input: meta
    });
    if (error) {
      console.error('Compteur de téléchargements :', error.message);
      return;
    }
    if (typeof total !== 'number') return;
    const el = document.getElementById('download-count-text');
    if (el) el.textContent = `${total} téléchargement${total > 1 ? 's' : ''}`;
  } catch (err) {
    console.error('Compteur de téléchargements :', err?.message || err);
  }
}

function starIcons(value, { interactive = false } = {}) {
  return Array.from({ length: 5 })
    .map((_, i) => {
      const filled = i < Math.round(value);
      return interactive
        ? `<button type="button" class="rate-star text-2xl leading-none px-0.5 ${filled ? 'rating-star' : 'text-[var(--border)]'}" data-score="${i + 1}" aria-label="Noter ${i + 1} étoile${i > 0 ? 's' : ''}">★</button>`
        : `<span class="${filled ? 'rating-star' : 'text-[var(--border)]'}">★</span>`;
    })
    .join('');
}

function render(app, current, versions, screenshots, comments, myRating) {
  const icon = app.icon_url || '/assets/icons/icon-512.png';
  const downloadTarget = current?.file_url || current?.external_url;
  const actionLabel = current?.external_url && !current?.file_url ? 'Ouvrir l\u2019app' : 'Télécharger';

  root.innerHTML = `
    <div class="flex flex-col sm:flex-row gap-6 items-start sm:items-center">
      <div class="icon-frame w-24 h-24 sm:w-28 sm:h-28">
        <img src="${icon}" alt="" class="w-full h-full object-cover" />
      </div>
      <div class="flex-1 min-w-0">
        <h1 class="font-display text-2xl sm:text-3xl font-bold">${escapeHtml(app.title)}</h1>
        <p class="text-[var(--muted)] mt-1">
          ${escapeHtml(app.developer_name)} · ${PLATFORM_LABELS[app.platform] || app.platform}
          ${app.website_url ? ` · <a href="${escapeHtml(app.website_url)}" target="_blank" rel="noopener" class="text-[var(--accent)] hover:underline">Site web</a>` : ''}
        </p>
        <div class="flex items-center gap-2 mt-2">
          <span>${starIcons(app.rating)}</span>
          <span id="rating-summary" class="text-sm text-[var(--muted)]">${Number(app.rating).toFixed(1)} (${app.rating_count || 0} avis) · <span id="download-count-text">${app.download_count} téléchargement${app.download_count > 1 ? 's' : ''}</span></span>
        </div>
      </div>
      ${downloadTarget
        ? `<button id="download-btn" class="btn-primary px-6 py-3 rounded-lg w-full sm:w-auto">${actionLabel}</button>`
        : `<button class="btn-ghost px-6 py-3 rounded-lg w-full sm:w-auto opacity-60 cursor-not-allowed" disabled title="Aucune version publiée pour le moment">Bientôt disponible</button>`
      }
    </div>
    ${downloadTarget
      ? `<p class="text-xs text-[var(--muted)] mt-2">En téléchargeant, des statistiques anonymes (source du lien, type d’appareil, langue) sont enregistrées sur Supabase. Aucune donnée personnelle n’est demandée.</p>`
      : ''}

    ${screenshots.length ? `
    <div class="mt-8">
      <h2 class="font-display text-lg font-semibold mb-3">Captures d'écran</h2>
      <div class="shelf flex gap-3 overflow-x-auto snap-x pb-2">
        ${screenshots.map((s) => `
          <button class="screenshot-trigger flex-shrink-0 snap-start rounded-lg overflow-hidden border border-[var(--border)]" data-src="${s.image_url}">
            <img src="${s.image_url}" alt="" class="h-64 w-auto object-cover" loading="lazy" />
          </button>`).join('')}
      </div>
    </div>` : ''}

    <div class="grid sm:grid-cols-4 gap-4 mt-8 surface rounded-xl p-4 text-sm">
      <div><p class="text-[var(--muted)]">Taille</p><p class="font-medium">${formatBytes(current?.file_size)}</p></div>
      <div><p class="text-[var(--muted)]">Version</p><p class="font-medium">${escapeHtml(current?.version_number || '-')}</p></div>
      <div><p class="text-[var(--muted)]">Plateforme</p><p class="font-medium">${PLATFORM_LABELS[app.platform] || app.platform}</p></div>
      <div><p class="text-[var(--muted)]">Mis à jour</p><p class="font-medium">${current ? formatDate(current.created_at) : formatDate(app.created_at)}</p></div>
    </div>

    <div class="mt-8">
      <h2 class="font-display text-lg font-semibold mb-2">Description</h2>
      <p class="text-[var(--muted)] leading-relaxed whitespace-pre-line">${escapeHtml(app.full_description || app.short_description)}</p>
    </div>

    ${current?.changelog ? `
    <div class="mt-8">
      <h2 class="font-display text-lg font-semibold mb-2">Notes de version - ${escapeHtml(current.version_number)}</h2>
      <p class="text-[var(--muted)] leading-relaxed whitespace-pre-line">${escapeHtml(current.changelog)}</p>
    </div>` : ''}

    ${versions.length > 1 ? `
    <div class="mt-8">
      <h2 class="font-display text-lg font-semibold mb-2">Historique des versions</h2>
      <ul class="space-y-2 text-sm">
        ${versions.slice(1).map((v) => `<li class="text-[var(--muted)]"><span class="text-[var(--text)] font-medium">${escapeHtml(v.version_number)}</span> - ${formatDate(v.created_at)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <div class="mt-10 surface rounded-xl p-5">
      <h2 class="font-display text-lg font-semibold mb-1">Votre note</h2>
      <p class="text-sm text-[var(--muted)] mb-2">Une seule note par appareil, modifiable à tout moment.</p>
      <div id="rate-stars" class="flex gap-1">${starIcons(myRating, { interactive: true })}</div>
      <p id="rate-feedback" class="text-sm text-[var(--accent)] mt-2 hidden">Merci pour ta note !</p>
    </div>

    <div class="mt-10">
      <h2 id="comments-heading" class="font-display text-lg font-semibold mb-3">Avis (${comments.length})</h2>
      <div id="comment-form-slot" class="mb-6"></div>
      <ul id="comments-list" class="space-y-4">
        ${comments.map(commentItem).join('') || '<li class="text-[var(--muted)] text-sm">Aucun avis pour le moment - sois le premier à commenter.</li>'}
      </ul>
    </div>
  `;

  document.getElementById('download-btn')?.addEventListener('click', () => handleDownloadClick(app, current));

  root.querySelectorAll('.screenshot-trigger').forEach((btn) => {
    btn.addEventListener('click', () => openLightbox(btn.dataset.src));
  });

  root.querySelectorAll('.rate-star').forEach((btn) => {
    btn.addEventListener('click', () => submitRating(app, Number(btn.dataset.score)));
  });

  renderCommentForm();
}

// La section de saisie d'avis dépend de l'état de connexion Firebase : on ne
// commente qu'en étant signé (policy RLS), donc on propose un bouton Google
// sign-in tant que l'utilisateur n'est pas connecté.
function renderCommentForm() {
  const slot = document.getElementById('comment-form-slot');
  if (!slot || !currentApp) return;

  if (!currentUser) {
    slot.innerHTML = `
      <div class="surface rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
        <p class="text-sm text-[var(--muted)]">Connecte-toi pour laisser un avis.</p>
        <button id="comment-signin-btn" class="btn-primary px-4 py-2 rounded-lg text-sm">Se connecter avec Google</button>
      </div>`;
    document.getElementById('comment-signin-btn').addEventListener('click', async () => {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err) {
        alert('Connexion impossible pour le moment.');
      }
    });
    return;
  }

  slot.innerHTML = `
    <form id="comment-form" class="surface rounded-xl p-4 space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-xs text-[var(--muted)]">Connecté en tant que ${escapeHtml(currentUser.email || currentUser.displayName || '')}</p>
        <button type="button" id="comment-signout-btn" class="text-xs text-[var(--muted)] hover:underline">Se déconnecter</button>
      </div>
      <div class="grid sm:grid-cols-3 gap-3">
        <input id="comment-author" required maxlength="60" placeholder="Ton nom" value="${escapeHtml(currentUser.displayName || '')}" class="sm:col-span-1 px-3 py-2 text-sm" />
        <input id="comment-body" required maxlength="1000" placeholder="Ton avis sur l'app…" class="sm:col-span-2 px-3 py-2 text-sm" />
      </div>
      <button type="submit" class="btn-primary px-4 py-2 rounded-lg text-sm">Publier</button>
    </form>`;

  document.getElementById('comment-signout-btn').addEventListener('click', () => signOut(auth));
  document.getElementById('comment-form').addEventListener('submit', (e) => submitComment(e, currentApp));
}

function commentItem(c) {
  return `<li class="surface rounded-xl p-4">
    <div class="flex items-center justify-between mb-1">
      <span class="font-medium text-sm">${escapeHtml(c.author_name)}</span>
      <span class="text-xs text-[var(--muted)]">${timeAgo(c.created_at)}</span>
    </div>
    <p class="text-sm text-[var(--muted)] whitespace-pre-line">${escapeHtml(c.body)}</p>
    ${c.admin_reply ? `
    <div class="mt-3 pl-3 border-l-2" style="border-color:var(--accent)">
      <p class="text-xs text-[var(--accent)] font-medium mb-0.5">Réponse de Nineteen J Games</p>
      <p class="text-sm whitespace-pre-line">${escapeHtml(c.admin_reply)}</p>
    </div>` : ''}
  </li>`;
}

async function submitRating(app, score) {
  const starsEl = document.getElementById('rate-stars');
  const feedback = document.getElementById('rate-feedback');
  starsEl.innerHTML = starIcons(score, { interactive: true });
  starsEl.querySelectorAll('.rate-star').forEach((btn) => {
    btn.addEventListener('click', () => submitRating(app, Number(btn.dataset.score)));
  });

  const { data, error } = await supabase.rpc('rate_app', {
    app_id_input: app.id,
    device_id_input: getDeviceId(),
    score_input: score
  });

  if (error) {
    feedback.textContent = 'Note non enregistrée - réessaie.';
    feedback.classList.remove('hidden', 'text-[var(--accent)]');
    feedback.classList.add('text-[var(--danger)]');
    return;
  }

  feedback.textContent = 'Merci pour ta note !';
  feedback.classList.remove('hidden');
  const agg = Array.isArray(data) ? data[0] : data;
  if (agg) {
    const ratingLine = document.getElementById('rating-summary');
    const dlText = document.getElementById('download-count-text')?.outerHTML || '';
    if (ratingLine) ratingLine.innerHTML = `${Number(agg.rating).toFixed(1)} (${agg.rating_count} avis) · ${dlText}`;
  }
}

async function submitComment(e, app) {
  e.preventDefault();
  const authorInput = document.getElementById('comment-author');
  const bodyInput = document.getElementById('comment-body');
  const author = authorInput.value.trim();
  const body = bodyInput.value.trim();
  if (!author || !body) return;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const { data, error } = await supabaseAuthed
    .from('app_comments')
    .insert({ app_id: app.id, author_name: author, body, author_uid: currentUser.uid })
    .select()
    .single();

  submitBtn.disabled = false;

  if (error) {
    alert("Impossible de publier ton avis pour le moment : " + error.message);
    return;
  }

  const list = document.getElementById('comments-list');
  const emptyState = list.querySelector('li');
  if (emptyState && !emptyState.classList.contains('surface')) emptyState.remove();
  list.insertAdjacentHTML('afterbegin', commentItem(data));
  document.getElementById('comments-heading').textContent = `Avis (${list.children.length})`;
  bodyInput.value = '';
}

// Lightbox minimal
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-6';
  overlay.innerHTML = `<img src="${src}" class="max-h-full max-w-full rounded-lg" alt="" />`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

loadApp();

// Même logique que store.js : rafraîchir si la page vient du bfcache.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) loadApp();
});
