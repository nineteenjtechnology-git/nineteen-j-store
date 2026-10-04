// Nineteen J Store — vitrine publique
import { supabase } from './supabase-config.js';
import './tracking.js'; // retient la source du lien (?src=…) dès l'arrivée sur l'accueil
import { initInstallBanner, registerServiceWorker } from './pwa-install.js';

registerServiceWorker();
initInstallBanner();

const state = {
  categories: [],
  apps: [],
  activeCategory: 'all',
  activePlatform: 'all',
  search: ''
};

const els = {
  featured: document.getElementById('featured-shelf'),
  grid: document.getElementById('apps-grid'),
  empty: document.getElementById('empty-state'),
  categoryChips: document.getElementById('category-chips'),
  platformChips: document.getElementById('platform-chips'),
  searchInput: document.getElementById('search-input'),
  yearNow: document.getElementById('year-now')
};

if (els.yearNow) els.yearNow.textContent = new Date().getFullYear();

const PLATFORM_LABELS = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  cross_platform: 'Multiplateforme'
};

function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function skeletonCards(n = 8) {
  return Array.from({ length: n })
    .map(
      () => `
      <div class="app-card p-4 flex gap-4 items-center">
        <div class="icon-frame skeleton w-16 h-16"></div>
        <div class="flex-1 space-y-2">
          <div class="skeleton h-4 w-3/4 rounded"></div>
          <div class="skeleton h-3 w-1/2 rounded"></div>
        </div>
      </div>`
    )
    .join('');
}

function starRow(rating) {
  const full = Math.round(rating);
  return Array.from({ length: 5 })
    .map((_, i) => `<span class="rating-star text-xs">${i < full ? '★' : '☆'}</span>`)
    .join('');
}

function formatDownloads(count) {
  return new Intl.NumberFormat('fr-FR', { notation: 'compact' }).format(Number(count) || 0);
}

function appCard(app) {
  const icon = app.icon_url || '/assets/icons/icon-192.png';
  const cat = state.categories.find((c) => c.id === app.category_id);
  return `
    <a href="/app/detail.html?slug=${encodeURIComponent(app.slug)}" class="app-card p-4 flex gap-4 items-center group">
      <div class="icon-frame w-16 h-16">
        <img src="${icon}" alt="" class="w-full h-full object-cover" loading="lazy" />
      </div>
      <div class="min-w-0 flex-1">
        <h3 class="font-display font-semibold truncate group-hover:text-[var(--accent)]">${escapeHtml(app.title)}</h3>
        <p class="text-sm text-[var(--muted)] truncate">${escapeHtml(cat?.name || 'Application')} · ${PLATFORM_LABELS[app.platform] || app.platform}</p>
        <div class="flex items-center gap-1 mt-1">${starRow(app.rating)}<span class="text-xs text-[var(--muted)] ml-1" title="${Number(app.download_count) || 0} téléchargement(s) · ${app.rating_count || 0} avis">${Number(app.rating).toFixed(1)} (${formatDownloads(app.download_count)})</span></div>
      </div>
    </a>`;
}

function featuredCard(app) {
  const icon = app.icon_url || '/assets/icons/icon-512.png';
  return `
    <a href="/app/detail.html?slug=${encodeURIComponent(app.slug)}"
       class="app-card relative flex-shrink-0 w-64 sm:w-72 h-40 overflow-hidden flex items-end p-4 snap-start">
      <img src="${icon}" alt="" class="absolute inset-0 w-full h-full object-cover opacity-25" loading="lazy" />
      <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
      <div class="relative">
        <p class="text-xs uppercase tracking-wide text-[var(--accent)] font-semibold mb-1">À la une</p>
        <h3 class="font-display text-lg font-semibold text-white truncate">${escapeHtml(app.title)}</h3>
        <p class="text-sm text-white/70 truncate">${escapeHtml(app.short_description)}</p>
      </div>
    </a>`;
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChips() {
  const catChips = [{ id: 'all', name: 'Toutes' }, ...state.categories];
  els.categoryChips.innerHTML = catChips
    .map(
      (c) => `<button class="chip px-3 py-1.5 text-sm" data-category="${c.id}" aria-pressed="${state.activeCategory === c.id}">${escapeHtml(c.name)}</button>`
    )
    .join('');

  const platforms = [['all', 'Toutes plateformes'], ...Object.entries(PLATFORM_LABELS)];
  els.platformChips.innerHTML = platforms
    .map(([id, label]) => `<button class="chip px-3 py-1.5 text-sm" data-platform="${id}" aria-pressed="${state.activePlatform === id}">${escapeHtml(label)}</button>`)
    .join('');
}

function applyFiltersAndRender() {
  const filtered = state.apps.filter((app) => {
    const matchCat = state.activeCategory === 'all' || app.category_id === state.activeCategory;
    const matchPlatform = state.activePlatform === 'all' || app.platform === state.activePlatform;
    const matchSearch =
      !state.search ||
      app.title.toLowerCase().includes(state.search) ||
      (app.short_description || '').toLowerCase().includes(state.search);
    return matchCat && matchPlatform && matchSearch;
  });

  els.grid.innerHTML = filtered.map(appCard).join('');
  els.empty.classList.toggle('hidden', filtered.length > 0);
}

async function loadData() {
  els.grid.innerHTML = skeletonCards();

  const [{ data: categories, error: catErr }, { data: apps, error: appErr }] = await Promise.all([
    supabase.from('categories').select('*').order('display_order').order('name'),
    supabase
      .from('apps')
      .select('id, title, slug, short_description, category_id, platform, icon_url, featured, rating, rating_count, download_count')
      .order('created_at', { ascending: false })
  ]);

  if (catErr || appErr) {
    els.grid.innerHTML = `<p class="col-span-full text-center text-[var(--danger)] py-12">Impossible de charger le catalogue pour le moment.</p>`;
    console.error(catErr || appErr);
    return;
  }

  state.categories = categories || [];
  state.apps = apps || [];

  renderChips();
  els.featured.innerHTML = state.apps.filter((a) => a.featured).map(featuredCard).join('') ||
    '<p class="text-[var(--muted)] text-sm">Aucune application mise en avant pour le moment.</p>';
  applyFiltersAndRender();
}

els.categoryChips?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-category]');
  if (!btn) return;
  state.activeCategory = btn.dataset.category;
  renderChips();
  applyFiltersAndRender();
});

els.platformChips?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-platform]');
  if (!btn) return;
  state.activePlatform = btn.dataset.platform;
  renderChips();
  applyFiltersAndRender();
});

els.searchInput?.addEventListener(
  'input',
  debounce((e) => {
    state.search = e.target.value.trim().toLowerCase();
    applyFiltersAndRender();
  }, 250)
);

// Thème clair/sombre
const themeToggle = document.getElementById('theme-toggle');
function applyStoredTheme() {
  const saved = localStorage.getItem('njs-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
}
applyStoredTheme();
themeToggle?.addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('njs-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('njs-theme', 'light');
  }
});

loadData();

// Si la page est restaurée depuis le bfcache du navigateur (bouton "retour"),
// le JS ne se réexécute pas : les compteurs affichés (téléchargements, notes)
// peuvent rester figés à leur valeur d'avant la navigation. On force un rechargement
// des données dans ce cas précis.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) loadData();
});
