// scripts/prerender.mjs — pré-rendu SEO du Store (Node 18+, aucune dépendance).
//
// Génère, depuis les apps PUBLIÉES dans Supabase (clé publishable + RLS, lecture seule) :
//   - public/apps/<slug>.html   fiche statique par app (title, description, canonical, OG, JSON-LD, contenu)
//   - public/sitemap.xml        accueil + fiches indexables
//   - bloc « liste des apps » de public/index.html (entre les marqueurs SEO:APPS-LIST)
// Le gabarit des fiches est public/app/detail.html (marqueurs SEO:HEAD et SEO:BODY) : un seul gabarit à maintenir.
//
// Usage : node scripts/prerender.mjs            (SITE_URL, SUPABASE_URL, SUPABASE_KEY facultatifs)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PUBLIC = join(process.cwd(), 'public');
const SITE_URL = (process.env.SITE_URL || 'https://nineteen-j-store.web.app').replace(/\/+$/, '');
const SITE_NAME = 'Nineteen J Store';
const ORG_NAME = 'Nineteen J Technology';
const MIN_WORDS = 20; // sous ce seuil la fiche reste générée (aperçu WhatsApp) mais en noindex, hors sitemap

const PLATFORM = { android: 'Android', ios: 'iOS', web: 'Web', cross_platform: 'Multiplateforme' };
const OS = { android: 'ANDROID', ios: 'IOS', web: 'Web', cross_platform: 'ANDROID, IOS, Web' };
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const words = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

// ---------- Config Supabase (valeurs publiques, déjà présentes dans supabase-config.js) ----------
async function supabaseConfig() {
  let url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    const src = await readFile(join(PUBLIC, 'js/supabase-config.js'), 'utf8');
    const ref = src.match(/SUPABASE_PROJECT_REF\s*=\s*'([^']+)'/)?.[1];
    url ||= ref && `https://${ref}.supabase.co`;
    key ||= src.match(/SUPABASE_PUBLISHABLE_KEY\s*=\s*'([^']+)'/)?.[1];
  }
  if (!url || !key) throw new Error('Config Supabase introuvable (SUPABASE_URL / SUPABASE_KEY).');
  return { url, key };
}

async function rest(cfg, path) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status} sur ${path.split('?')[0]} : ${await res.text()}`);
  return res.json();
}

const between = (html, tag, inner) => {
  const re = new RegExp(`(<!-- SEO:${tag}:START -->)[\\s\\S]*?(<!-- SEO:${tag}:END -->)`);
  if (!re.test(html)) throw new Error(`Marqueur SEO:${tag} absent.`);
  return html.replace(re, (_, a, b) => `${a}\n${inner}\n${b}`);
};

// ---------- Contenu d'une fiche ----------
function metaFor(app, cat, current) {
  const plat = PLATFORM[app.platform] || app.platform;
  const verb = app.platform === 'web' ? `${app.title} : application web` : `Télécharger ${app.title} pour ${plat}`;
  let title = `${verb} | ${SITE_NAME}`;
  if (title.length > 62) title = clip(verb, 62);
  const base = (app.short_description || '').trim();
  const extra = (app.full_description || '').trim().split(/(?<=[.!?])\s/)[0] || '';
  let desc = base;
  const joined = `${base.replace(/[.!?]?$/, '.')} ${extra}`.replace(/\s+/g, ' ');
  // On complète la description courte avec la 1re phrase du texte long seulement si le tout tient dans un snippet.
  if (base.length < 110 && extra && !base.includes(extra) && joined.length <= 158) desc = joined;
  desc = clip(desc.replace(/\s+/g, ' '), 158);
  const url = `${SITE_URL}/apps/${encodeURIComponent(app.slug)}`;
  const image = app.icon_url || `${SITE_URL}/assets/icons/icon-512.png`;
  const text = `${app.short_description || ''} ${app.full_description || ''}`;
  const indexable = words(text) >= MIN_WORDS;
  return { title, desc, url, image, indexable, plat, current };
}

function category(catName = '') {
  const n = catName.toLowerCase();
  if (/jeu|game/.test(n)) return 'GameApplication';
  if (/éduc|educ|étud|etud|scol/.test(n)) return 'EducationalApplication';
  if (/financ|factur|compta/.test(n)) return 'FinanceApplication';
  if (/outil|util|product/.test(n)) return 'UtilitiesApplication';
  return undefined; // inconnue : on n'invente pas
}

function jsonLd(app, m, catName, shots) {
  const type = app.platform === 'web' ? 'WebApplication' : app.platform === 'cross_platform' ? 'SoftwareApplication' : 'MobileApplication';
  const rated = Number(app.rating) > 0 && Number(app.rating_count) > 0;
  const sw = {
    '@type': type, name: app.title, description: m.desc, url: m.url, image: m.image,
    inLanguage: 'fr', operatingSystem: OS[app.platform] || 'Any',
    applicationCategory: category(catName),
    softwareVersion: m.current?.version_number || undefined,
    datePublished: app.created_at || undefined, dateModified: app.updated_at || undefined,
    author: { '@type': 'Organization', name: app.developer_name || ORG_NAME },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'XOF' },
    screenshot: shots.length ? shots.slice(0, 5).map((s) => s.image_url) : undefined,
    aggregateRating: rated ? { '@type': 'AggregateRating', ratingValue: Number(app.rating), ratingCount: Number(app.rating_count), bestRating: 5, worstRating: 1 } : undefined
  };
  return ld({
    '@context': 'https://schema.org',
    '@graph': [sw, { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: app.title }
    ] }]
  });
}

function headBlock(app, m, catName, shots) {
  return [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.desc)}" />`,
    m.indexable ? '' : '<meta name="robots" content="noindex, follow" />',
    `<link rel="canonical" href="${esc(m.url)}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:locale" content="fr_FR" />',
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.desc)}" />`,
    `<meta property="og:url" content="${esc(m.url)}" />`,
    `<meta property="og:image" content="${esc(m.image)}" />`,
    `<meta property="og:image:alt" content="${esc(`Icône de ${app.title}`)}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<script type="application/ld+json">${jsonLd(app, m, catName, shots)}</script>`
  ].filter(Boolean).join('\n');
}

// Remplacé par app-detail.js dès que les données live sont chargées (root.innerHTML).
function bodyBlock(app, m, catName, shots) {
  const icon = esc(app.icon_url || '/assets/icons/icon-512.png');
  const paras = String(app.full_description || app.short_description || '').split(/\n{2,}/).map((p) => `<p class="text-[var(--muted)] leading-relaxed whitespace-pre-line">${esc(p)}</p>`).join('\n');
  const imgs = shots.slice(0, 6).map((s, i) => `<img src="${esc(s.image_url)}" alt="${esc(`Capture d'écran ${i + 1} de ${app.title}`)}" class="h-64 w-auto object-cover rounded-lg" loading="lazy" />`).join('\n');
  // Même structure que le rendu live (app-detail.js) pour limiter le décalage de mise en page (CLS) au remplacement.
  return `<div class="flex flex-col sm:flex-row gap-6 items-start sm:items-center">
  <div class="icon-frame w-24 h-24 sm:w-28 sm:h-28"><img src="${icon}" alt="${esc(`Icône de ${app.title}`)}" width="112" height="112" class="w-full h-full object-cover" /></div>
  <div class="flex-1 min-w-0">
    <h1 class="font-display text-2xl sm:text-3xl font-bold">${esc(app.title)}</h1>
    <p class="text-[var(--muted)] mt-1">${esc(app.developer_name || ORG_NAME)} · ${esc(m.plat)}${catName ? ` · ${esc(catName)}` : ''}${m.current?.version_number ? ` · version ${esc(m.current.version_number)}` : ''}</p>
  </div>
</div>
${imgs ? `<div class="mt-8"><h2 class="font-display text-lg font-semibold mb-3">Captures d'écran</h2><div class="shelf flex gap-3 overflow-x-auto pb-2">${imgs}</div></div>` : ''}
<div class="mt-8"><h2 class="font-display text-lg font-semibold mb-2">Description</h2>
${paras}</div>`;
}

function cardHtml(app, catName) {
  const icon = esc(app.icon_url || '/assets/icons/icon-192.png');
  return `<a href="/apps/${encodeURIComponent(app.slug)}" class="app-card p-4 flex gap-4 items-center group">
  <div class="icon-frame w-16 h-16"><img src="${icon}" alt="" width="64" height="64" class="w-full h-full object-cover" loading="lazy" /></div>
  <div class="min-w-0 flex-1"><h2 class="font-display font-semibold truncate">${esc(app.title)}</h2>
  <p class="text-sm text-[var(--muted)] truncate">${esc(catName || 'Application')} · ${esc(PLATFORM[app.platform] || app.platform)}</p></div></a>`;
}

// ---------- Main ----------
const cfg = await supabaseConfig();
const [apps, cats, versions, shots] = await Promise.all([
  rest(cfg, 'apps?select=*&status=eq.published&order=updated_at.desc'),
  rest(cfg, 'categories?select=id,name'),
  rest(cfg, 'app_versions?select=app_id,version_number,created_at&is_current=eq.true'),
  rest(cfg, 'app_screenshots?select=app_id,image_url,display_order&order=display_order.asc')
]);
const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
const curBy = Object.fromEntries(versions.map((v) => [v.app_id, v]));
const shotsBy = {};
for (const s of shots) (shotsBy[s.app_id] ||= []).push(s);

const template = await readFile(join(PUBLIC, 'app/detail.html'), 'utf8');
const outDir = join(PUBLIC, 'apps');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const urls = [{ loc: `${SITE_URL}/`, lastmod: (apps[0]?.updated_at || '').slice(0, 10) }];
let thin = 0;
for (const app of apps) {
  if (!app.slug || !/^[a-z0-9][a-z0-9-]*$/i.test(app.slug)) { console.warn(`Slug ignoré : ${app.slug}`); continue; }
  const name = catName[app.category_id];
  const m = metaFor(app, name, curBy[app.id]);
  const mine = shotsBy[app.id] || [];
  let html = between(template, 'HEAD', headBlock(app, m, name, mine));
  html = between(html, 'BODY', bodyBlock(app, m, name, mine));
  await writeFile(join(outDir, `${app.slug}.html`), html, 'utf8');
  if (m.indexable) urls.push({ loc: m.url, lastmod: (app.updated_at || '').slice(0, 10) }); else thin++;
}

await writeFile(join(PUBLIC, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>\n', 'utf8');

const indexPath = join(PUBLIC, 'index.html');
await writeFile(indexPath, between(await readFile(indexPath, 'utf8'), 'APPS-LIST', apps.map((a) => cardHtml(a, catName[a.category_id])).join('\n')), 'utf8');

console.log(`Pré-rendu : ${apps.length} app(s) publiée(s) → ${apps.length - thin} indexable(s), ${thin} en noindex (contenu < ${MIN_WORDS} mots). Sitemap : ${urls.length} URL.`);
