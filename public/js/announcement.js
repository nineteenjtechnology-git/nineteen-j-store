// Nineteen J Store - message d'accueil (fenêtre affichée à l'entrée du site, pilotée depuis l'admin).
// Tout le texte est inséré via textContent : aucune injection HTML possible.
import { supabase } from './supabase-config.js';

const SEEN_KEY = 'njs-announcement-seen'; // mode « une seule fois » : dernière version vue
const SESSION_KEY = 'njs-announcement-session'; // mode « à chaque visite » : version déjà montrée pendant cette session

function safeLink(url) {
  if (!url) return null;
  if (/^\/(?!\/)\S*$/.test(url)) return { href: url, external: false };
  if (/^https:\/\/\S+$/i.test(url)) return { href: url, external: true };
  return null;
}

// data = { title, message, link_label, link_url } ; options.preview = true : aperçu admin, rien n'est mémorisé.
export function openAnnouncement(data, { preview = false } = {}) {
  document.getElementById('njs-announcement')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'njs-announcement';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'njs-announcement-title');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '70', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '16px', background: 'rgba(0,0,0,.6)'
  });

  const card = document.createElement('div');
  card.className = 'surface rounded-2xl';
  Object.assign(card.style, { width: '100%', maxWidth: '440px', maxHeight: '85vh', overflowY: 'auto', padding: '24px', boxShadow: '0 20px 60px rgba(0,0,0,.5)' });

  if (data.title) {
    const h = document.createElement('h2');
    h.id = 'njs-announcement-title';
    h.className = 'font-display';
    Object.assign(h.style, { fontSize: '20px', fontWeight: '700', marginBottom: '8px' });
    h.textContent = data.title;
    card.appendChild(h);
  }
  if (data.message) {
    const p = document.createElement('p');
    Object.assign(p.style, { fontSize: '15px', lineHeight: '1.5', whiteSpace: 'pre-line', color: 'var(--muted)' });
    p.textContent = data.message;
    card.appendChild(p);
  }

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '20px' });

  const link = safeLink(data.link_url);
  if (link) {
    const a = document.createElement('a');
    a.className = 'btn-primary px-4 py-2 rounded-lg text-sm';
    a.href = link.href;
    a.textContent = data.link_label || 'Voir';
    if (link.external) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    actions.appendChild(a);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn-ghost px-4 py-2 rounded-lg text-sm';
  close.textContent = link ? 'Fermer' : 'OK';
  actions.appendChild(close);
  card.appendChild(actions);
  overlay.appendChild(card);

  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const onKey = (e) => {
    if (e.key === 'Escape') dismiss();
  };
  function dismiss() {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = previousOverflow;
    overlay.remove();
  }
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  close.focus();
}

// Appelée à l'arrivée sur une page publique : affiche le message actif, selon son mode.
export async function showAnnouncementIfAny() {
  try {
    const { data, error } = await supabase.rpc('get_site_announcement');
    if (error || !data) return;

    if (data.mode === 'always') {
      if (sessionStorage.getItem(SESSION_KEY) === String(data.version)) return;
      sessionStorage.setItem(SESSION_KEY, String(data.version));
    } else {
      if (Number(localStorage.getItem(SEEN_KEY)) >= Number(data.version)) return;
      localStorage.setItem(SEEN_KEY, String(data.version));
    }
    setTimeout(() => openAnnouncement(data), 500);
  } catch {
    /* un message d'accueil ne doit jamais gêner le chargement du site */
  }
}
