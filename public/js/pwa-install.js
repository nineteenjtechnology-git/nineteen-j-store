// Nineteen J Store - bannière d'installation PWA custom
let deferredPrompt = null;

function getBanner() {
  return document.getElementById('install-banner');
}

function showBanner() {
  const banner = getBanner();
  if (!banner) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return; // déjà installé
  if (sessionStorage.getItem('njs-install-dismissed')) return;
  banner.classList.remove('hidden');
}

function hideBanner() {
  const banner = getBanner();
  if (banner) banner.classList.add('hidden');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  showBanner();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  hideBanner();
});

export function initInstallBanner() {
  const installBtn = document.getElementById('install-btn');
  const dismissBtn = document.getElementById('install-dismiss');

  installBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') hideBanner();
    deferredPrompt = null;
  });

  dismissBtn?.addEventListener('click', () => {
    sessionStorage.setItem('njs-install-dismissed', '1');
    hideBanner();
  });
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('[SW] échec d\u2019enregistrement', err);
    });
  });
}
