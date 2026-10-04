// Nineteen J Store - sondage général, proposé après le téléchargement de N'IMPORTE QUELLE app.
//
// Principes :
//  - le téléchargement a déjà démarré quand la fenêtre apparaît (jamais bloquant) ;
//  - tout est facultatif et anonyme (pas de nom, pas d'e-mail) ;
//  - la personne est informée que les réponses sont enregistrées sur Supabase ;
//  - une seule réponse par appareil : une fois répondu, on ne redemande plus ;
//    si la personne refuse, on ne redemande pas avant 30 jours.
import { supabase } from './supabase-config.js';
import { getDeviceId } from './device-id.js';

const STORAGE_KEY = 'njs-survey';
const RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const QUESTIONS = [
  {
    key: 'statut',
    label: 'Tu es…',
    options: [
      ['eleve', 'Élève'],
      ['etudiant', 'Étudiant(e)'],
      ['enseignant', 'Enseignant(e)'],
      ['professionnel', 'Professionnel(le)'],
      ['autre', 'Autre']
    ]
  },
  {
    key: 'usage',
    label: 'Tu télécharges cette app pour…',
    options: [
      ['etudes', 'Mes études'],
      ['travail', 'Mon travail'],
      ['loisirs', 'Mes loisirs'],
      ['autre', 'Autre']
    ]
  },
  {
    key: 'decouverte',
    label: 'Comment as-tu connu ce store ?',
    options: [
      ['whatsapp', 'WhatsApp'],
      ['facebook', 'Facebook'],
      ['tiktok_instagram', 'TikTok / Instagram'],
      ['ami', 'Un(e) ami(e)'],
      ['autre', 'Autre']
    ]
  }
];

function readState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeState(status) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ status, at: Date.now() }));
  } catch {
    /* ignoré */
  }
}

function storageAvailable() {
  try {
    localStorage.setItem('njs-probe', '1');
    localStorage.removeItem('njs-probe');
    return true;
  } catch {
    return false;
  }
}

function shouldAsk() {
  // Sans stockage local on ne pourrait pas mémoriser la réponse : on ne harcèle pas.
  if (!storageAvailable()) return false;
  if (document.getElementById('njs-survey')) return false;
  const state = readState();
  if (!state) return true;
  if (state.status === 'done') return false;
  return Date.now() - (state.at || 0) > RETRY_AFTER_MS;
}

function buildModal() {
  const questionsHtml = QUESTIONS.map(
    (q) => `
      <div class="njs-q" data-q="${q.key}">
        <p class="njs-q-label">${q.label}</p>
        <div class="njs-chips">
          ${q.options
            .map(([value, text]) => `<button type="button" class="chip" data-value="${value}" aria-pressed="false">${text}</button>`)
            .join('')}
        </div>
      </div>`
  ).join('');

  const wrap = document.createElement('div');
  wrap.id = 'njs-survey';
  wrap.className = 'njs-modal-backdrop';
  wrap.innerHTML = `
    <div class="njs-modal surface" role="dialog" aria-modal="true" aria-labelledby="njs-survey-title">
      <h2 id="njs-survey-title" class="font-display" style="font-size:1.15rem;font-weight:700">Une minute pour nous aider ?</h2>
      <p style="margin-top:.35rem;font-size:.9rem;color:var(--muted)">Ton téléchargement a démarré. Ces questions sont facultatives.</p>
      <p class="njs-notice">
        Tes réponses sont anonymes : nous ne te demandons ni nom ni e-mail. Elles sont enregistrées sur
        Supabase, la base de données du store, et servent à mieux connaître son public.
      </p>
      ${questionsHtml}
      <div class="njs-q">
        <label class="njs-q-label" for="njs-ville">Ta ville (facultatif)</label>
        <input id="njs-ville" class="njs-input" type="text" maxlength="60" autocomplete="off" placeholder="Abidjan" />
      </div>
      <p id="njs-status" class="njs-notice" role="status" aria-live="polite"></p>
      <div class="njs-actions">
        <button type="button" class="btn-ghost px-4 py-2 rounded-lg text-sm" data-act="skip">Non merci</button>
        <button type="button" class="btn-primary px-4 py-2 rounded-lg text-sm" data-act="send" disabled>Envoyer</button>
      </div>
    </div>`;
  return wrap;
}

function openSurvey(app) {
  const root = buildModal();
  document.body.appendChild(root);

  const answers = {};
  const sendBtn = root.querySelector('[data-act="send"]');
  const status = root.querySelector('#njs-status');
  const cityInput = root.querySelector('#njs-ville');

  const close = () => {
    document.removeEventListener('keydown', onKey);
    root.remove();
  };
  const dismiss = () => {
    writeState('dismissed');
    close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') dismiss();
  };
  document.addEventListener('keydown', onKey);

  const refreshSendState = () => {
    sendBtn.disabled = !(Object.keys(answers).length || cityInput.value.trim());
  };

  root.addEventListener('click', async (e) => {
    if (e.target === root) return dismiss();

    const chip = e.target.closest('.chip');
    if (chip) {
      const key = chip.closest('[data-q]').dataset.q;
      const value = chip.dataset.value;
      const wasActive = answers[key] === value;
      chip.closest('.njs-chips').querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      if (wasActive) {
        delete answers[key];
      } else {
        answers[key] = value;
        chip.setAttribute('aria-pressed', 'true');
      }
      refreshSendState();
      return;
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'skip') return dismiss();
    if (act === 'send') {
      const payload = { ...answers };
      const city = cityInput.value.trim();
      if (city) payload.ville = city;

      sendBtn.disabled = true;
      status.textContent = 'Envoi…';
      try {
        const { error } = await supabase.rpc('submit_survey', {
          app_id_input: app.id,
          device_id_input: getDeviceId(),
          answers_input: payload
        });
        if (error) throw error;
        writeState('done');
        status.textContent = 'Merci, c’est enregistré !';
        setTimeout(close, 1400);
      } catch (err) {
        console.error('Sondage :', err?.message || err);
        status.textContent = 'Envoi impossible pour le moment. Tu peux fermer, ce n’est pas grave.';
        sendBtn.disabled = false;
      }
    }
  });

  cityInput.addEventListener('input', refreshSendState);
  root.querySelector('.chip')?.focus();
}

// Appelé juste après le déclenchement du téléchargement.
export function maybeAskSurvey(app) {
  try {
    if (!shouldAsk()) return;
    setTimeout(() => {
      if (shouldAsk()) openSurvey(app);
    }, 1200);
  } catch (err) {
    console.error('Sondage :', err?.message || err);
  }
}
