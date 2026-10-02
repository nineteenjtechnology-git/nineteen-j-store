// Nineteen J Store - client Supabase pour tout visiteur connecté via Firebase
// (distinct de supabase-admin.js : même mécanisme technique - le token Firebase
// sert de JWT - mais ici n'importe quel compte signé peut écrire, pas seulement
// un admin. Les policies RLS décident qui peut faire quoi selon la table :
// pour app_comments, "signé" suffit ; pour apps/categories/versions, il faut
// en plus role='admin' dans `profiles` (private.is_admin()).
// supabase-js 2.117.2 vendorisé (/js/vendor/supabase.js, chargé en <script> avant ce module) :
// version figée, servie depuis notre domaine, plus de dépendance à un CDN tiers (audit H1).
const { createClient } = window.supabase;
import { auth } from './firebase-config.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

export const supabaseAuthed = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  accessToken: async () => {
    const user = auth.currentUser;
    if (!user) return null;
    return user.getIdToken();
  }
});
