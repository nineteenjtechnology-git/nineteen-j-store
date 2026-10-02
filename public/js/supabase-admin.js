// Nineteen J Store - client Supabase "admin", authentifié via Firebase (Third-Party Auth)
//
// Contrairement à supabase-config.js (clé publishable seule, lecture publique),
// ce client attache le ID token Firebase de l'utilisateur courant à chaque requête.
// Supabase vérifie ce token (une fois le projet Firebase enregistré dans
// Authentication > Third-Party Auth, côté Dashboard Supabase - voir README) et les
// policies RLS (fonction private.is_admin()) autorisent alors les écritures pour
// les comptes ayant role='admin' dans la table `profiles`. Aucune clé secrète
// n'est jamais présente côté client : tout repose sur la vérification cryptographique
// du token par Supabase lui-même.
// supabase-js 2.117.2 vendorisé (/js/vendor/supabase.js, chargé en <script> avant ce module) :
// version figée, servie depuis notre domaine, plus de dépendance à un CDN tiers (audit H1).
const { createClient } = window.supabase;
import { auth } from './firebase-config.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: async () => {
    const user = auth.currentUser;
    if (!user) return null;
    return user.getIdToken();
  }
});
