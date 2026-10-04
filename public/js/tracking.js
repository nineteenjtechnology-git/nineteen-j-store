// Nineteen J Store - statistiques anonymes de téléchargement
//
// 1) SOURCE du lien : on retient ?src=... (ou ?ref=, ?utm_source=) à l'arrivée sur n'importe quelle
//    page du store, pour ne pas la perdre quand la personne passe de l'accueil à la page d'une app.
//    Exemple : https://nineteen-j-store.web.app/?src=whatsapp
//    À défaut, on utilise le site d'origine (referrer), sinon "direct".
// 2) INFOS TECHNIQUES non identifiantes (type d'appareil, langue, etc.), envoyées avec le comptage.
//    Aucun nom, e-mail, ni identifiant publicitaire : voir la mention affichée sur la page de l'app.
const SRC_KEY = 'njs-src';

function clean(value, max = 40) {
  if (!value) return null;
  const s = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return s || null;
}

function captureSource() {
  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = clean(params.get('src') || params.get('ref') || params.get('utm_source'));
    if (fromUrl) {
      sessionStorage.setItem(SRC_KEY, fromUrl);
      return;
    }
    if (sessionStorage.getItem(SRC_KEY)) return;
    if (document.referrer) {
      const host = new URL(document.referrer).hostname.replace(/^www\./, '');
      if (host && host !== location.hostname) sessionStorage.setItem(SRC_KEY, clean(host));
    }
  } catch {
    /* stockage indisponible (navigation privée stricte…) : on retombera sur "direct" */
  }
}
captureSource();

export function getSource() {
  try {
    return sessionStorage.getItem(SRC_KEY) || 'direct';
  } catch {
    return 'direct';
  }
}

function detectOs(ua) {
  let m;
  if ((m = ua.match(/Android[\s/]([\d.]+)/))) return { os: 'android', version: m[1] };
  if ((m = ua.match(/(?:iPhone|iPad|iPod).*?OS\s([\d_]+)/))) return { os: 'ios', version: m[1].replace(/_/g, '.') };
  if (/Windows/.test(ua)) return { os: 'windows', version: null };
  if (/Mac OS X/.test(ua)) return { os: 'macos', version: null };
  if (/Linux/.test(ua)) return { os: 'linux', version: null };
  return { os: 'autre', version: null };
}

function detectBrowser(ua) {
  // Navigateurs intégrés aux applications : utile pour savoir d'où viennent les gens.
  if (/FBAN|FBAV/.test(ua)) return 'facebook-app';
  if (/Instagram/.test(ua)) return 'instagram-app';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'tiktok-app';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'autre';
}

function screenBucket() {
  const w = Math.min(screen.width || 0, screen.height || 0) || screen.width || 0;
  if (!w) return null;
  if (w < 360) return '<360';
  if (w < 414) return '360-413';
  if (w < 600) return '414-599';
  return '600+';
}

// Renvoie un objet de métadonnées anonymes. Ne lève jamais d'exception.
export async function getClientMeta() {
  try {
    const ua = navigator.userAgent || '';
    const { os, version } = detectOs(ua);
    let osVersion = version;
    let model = null;

    // Chrome Android fige l'UA ("Android 10; K") : les Client Hints donnent la vraie version et le modèle.
    try {
      const uad = navigator.userAgentData;
      if (uad?.getHighEntropyValues) {
        const hv = await uad.getHighEntropyValues(['model', 'platformVersion']);
        if (hv.model) model = String(hv.model).slice(0, 40);
        if (os === 'android' && hv.platformVersion) osVersion = hv.platformVersion;
      }
    } catch {
      /* non supporté */
    }

    return {
      os,
      os_version: osVersion ? String(osVersion).split('.')[0] : null, // version majeure seulement
      browser: detectBrowser(ua),
      model,
      lang: (navigator.language || '').slice(0, 12) || null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      screen: screenBucket(),
      mode: window.matchMedia?.('(display-mode: standalone)').matches ? 'app' : 'navigateur',
      net: navigator.connection?.effectiveType || null
    };
  } catch {
    return null;
  }
}
