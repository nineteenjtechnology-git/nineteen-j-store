// Nineteen J Store - mémoire locale des apps déjà téléchargées sur CET appareil/navigateur.
// Pas d'adresse IP (partagée en 4G/Wi-Fi, change tout le temps) : on retient simplement, dans le
// navigateur, quelle version de quelle app a été téléchargée. Aucune donnée n'est envoyée au serveur.
const KEY = 'njs-installs';

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* stockage indisponible : on retombera simplement sur le bouton « Télécharger » */
  }
}

export function getInstall(appId) {
  return readAll()[appId] || null;
}

export function markInstalled(appId, version) {
  const all = readAll();
  all[appId] = {
    version_id: version?.id || null,
    version_number: version?.version_number || null,
    at: new Date().toISOString()
  };
  writeAll(all);
}

export function forgetInstall(appId) {
  const all = readAll();
  delete all[appId];
  writeAll(all);
}

// 'none' = jamais téléchargée ici · 'current' = à jour · 'outdated' = une version plus récente existe
export function installState(appId, currentVersion) {
  const inst = getInstall(appId);
  if (!inst || !currentVersion) return { state: 'none', inst: null };
  const same = inst.version_id
    ? inst.version_id === currentVersion.id
    : inst.version_number === currentVersion.version_number;
  return { state: same ? 'current' : 'outdated', inst };
}

// Liens d'ouverture autorisés : schéma://… (ex. allococrush://open), jamais de schéma exécutable.
const BLOCKED_SCHEMES = /^(javascript|data|vbscript|file|blob|about):/i;
export function safeOpenUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(u) || BLOCKED_SCHEMES.test(u) || u.length > 300) return null;
  return u;
}
