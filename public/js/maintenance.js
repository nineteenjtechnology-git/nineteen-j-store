// Nineteen J Store - mode maintenance : page plein écran qui remplace le site public.
// Piloté depuis l'admin (jamais appelé par le panneau admin, qui reste toujours accessible).
// Tout le texte est inséré via textContent : aucune injection HTML possible.
import { supabase } from './supabase-config.js';

const WATCH_MS = 60000;

// data = { title, message, ends_at } ; options.preview = true : aperçu admin (se ferme, ne surveille rien).
export function showMaintenancePage(data, { preview = false } = {}) {
  document.getElementById('njs-maintenance')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'njs-maintenance';
  overlay.setAttribute('role', 'main');
  Object.assign(overlay.style, {
    // top/left/width/height explicites (et non `inset`) : fonctionne aussi sur les navigateurs Android plus anciens.
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', boxSizing: 'border-box',
    zIndex: '100', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px', background: 'var(--bg, #0c0a08)', color: 'var(--text, #f4efe4)', overflowY: 'auto', textAlign: 'center'
  });

  const box = document.createElement('div');
  Object.assign(box.style, { maxWidth: '460px', width: '100%' });

  const logo = document.createElement('img');
  logo.src = '/assets/icons/icon-192.png';
  logo.alt = '';
  Object.assign(logo.style, { width: '72px', height: '72px', borderRadius: '16px', margin: '0 auto 20px', display: 'block' });
  box.appendChild(logo);

  const h = document.createElement('h1');
  h.className = 'font-display';
  Object.assign(h.style, { fontSize: '26px', fontWeight: '700', marginBottom: '12px' });
  h.textContent = data.title || 'Maintenance en cours';
  box.appendChild(h);

  if (data.message) {
    const p = document.createElement('p');
    Object.assign(p.style, { fontSize: '16px', lineHeight: '1.55', whiteSpace: 'pre-line', color: 'var(--muted, #b8ad99)' });
    p.textContent = data.message;
    box.appendChild(p);
  }

  const end = data.ends_at ? new Date(data.ends_at) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > Date.now()) {
    const e = document.createElement('p');
    Object.assign(e.style, { marginTop: '16px', fontSize: '15px', fontWeight: '600', color: 'var(--accent, #f59e0b)' });
    e.textContent = `Retour prévu : ${end.toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
    box.appendChild(e);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary px-5 py-2 rounded-lg text-sm';
  btn.style.marginTop = '24px';
  btn.textContent = preview ? "Fermer l'aperçu" : 'Réessayer';
  btn.addEventListener('click', () => (preview ? overlay.remove() : location.reload()));
  box.appendChild(btn);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  if (!preview) {
    document.body.style.overflow = 'hidden';
    document.title = 'Maintenance - Nineteen J Store';
  }
}

let endWatchStarted = false;
let startWatchStarted = false;

// Maintenance affichée : quand elle se termine, la page se recharge toute seule.
function watchForEnd() {
  if (endWatchStarted) return;
  endWatchStarted = true;
  setInterval(async () => {
    try {
      const { data, error } = await supabase.rpc('get_maintenance');
      if (!error && !data) location.reload();
    } catch {
      /* réseau indisponible : on réessaiera */
    }
  }, WATCH_MS);
}

// Site accessible : si la maintenance est activée PENDANT que le visiteur a déjà la page ouverte, la page de
// maintenance s'affiche d'elle-même (vérification toutes les 45 s, et dès que l'onglet redevient visible).
function watchForStart() {
  if (startWatchStarted) return;
  startWatchStarted = true;
  let shown = false;
  const check = async () => {
    if (shown || document.hidden) return;
    try {
      const { data, error } = await supabase.rpc('get_maintenance');
      if (!error && data) {
        shown = true;
        showMaintenancePage(data);
        watchForEnd();
      }
    } catch {
      /* réseau indisponible : on réessaiera */
    }
  };
  setInterval(check, 45000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) check();
  });
}

// À appeler en tout début de page publique. Renvoie true si le site est en maintenance (la page est alors affichée :
// l'appelant ne doit rien charger d'autre). En cas d'erreur réseau, le site reste accessible (on ne bloque jamais à tort).
export async function checkMaintenance() {
  try {
    const { data, error } = await supabase.rpc('get_maintenance');
    if (error) {
      watchForStart();
      return false;
    }
    if (!data) {
      watchForStart();
      return false;
    }
    showMaintenancePage(data);
    watchForEnd();
    return true;
  } catch {
    watchForStart();
    return false;
  }
}
