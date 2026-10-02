// Nineteen J Store - client Supabase (lecture publique uniquement)
// La clé "publishable" ci-dessous n'autorise QUE ce que les policies RLS
// publiques permettent (SELECT sur categories/apps/versions/screenshots).
// Les écritures admin passent par supabase-admin.js (token Firebase en guise
// de JWT), jamais par ce client-ci.
// supabase-js 2.117.2 vendorisé (/js/vendor/supabase.js, chargé en <script> avant ce module) :
// version figée, servie depuis notre domaine, plus de dépendance à un CDN tiers (audit H1).
const { createClient } = window.supabase;

export const SUPABASE_PROJECT_REF = 'rrlayjervibobxiucbuu';
export const SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_qOCcrFOqNBNVwAu-cWFqYw_WQBzL5uT';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
