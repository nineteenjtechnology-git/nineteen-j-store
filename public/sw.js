// Nineteen J Store - Service Worker
// v2 (audit sécurité B3) :
//  - le code applicatif (HTML/JS/CSS) est servi réseau d'abord : un correctif de sécurité
//    arrive immédiatement, le cache ne sert que de secours hors-ligne ;
//  - stale-while-revalidate réservé aux ressources statiques inertes (images, polices) ;
//  - les requêtes authentifiées (jeton Firebase de l'admin / d'un visiteur connecté) ne
//    sont JAMAIS interceptées ni mises en cache.
const CACHE_VERSION = 'njs-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/assets/css/styles.css',
  '/assets/css/tailwind.css',
  '/assets/css/offline.css',
  '/js/vendor/supabase.js',
  '/js/vendor/lucide.min.js',
  '/js/icons-init.js',
  '/js/offline.js',
  '/js/firebase-config.js',
  '/js/supabase-config.js',
  '/js/pwa-install.js',
  '/js/store.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('njs-') && key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isDataRequest(url) {
  return url.hostname.endsWith('supabase.co');
}

function isInertAsset(url) {
  return /\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(url.pathname);
}

// Requête portant le jeton d'un utilisateur (JWT Firebase) : on n'y touche pas.
// La clé publishable Supabase (anonyme) reste, elle, cacheable.
function isUserAuthenticated(request) {
  const auth = request.headers.get('authorization');
  return !!auth && !auth.includes('sb_publishable_');
}

// Réseau d'abord, cache en secours (code applicatif, données dynamiques)
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return (await caches.open(SHELL_CACHE)).match('/offline.html');
    throw err;
  }
}

// Stale-While-Revalidate : uniquement pour les ressources statiques inertes
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await networkFetch) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isUserAuthenticated(request)) return;

  const url = new URL(request.url);

  if (isDataRequest(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(isInertAsset(url) ? staleWhileRevalidate(request) : networkFirst(request, SHELL_CACHE));
  }
});
