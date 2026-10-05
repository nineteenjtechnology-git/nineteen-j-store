-- Nineteen J Store — lien d'ouverture d'une app (bouton « Ouvrir l'app » après téléchargement).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front (l'admin écrit cette colonne).
-- Valeur type : allococrush://open  (schéma personnalisé déclaré par l'app Android).
alter table public.apps add column if not exists open_url text;

alter table public.apps drop constraint if exists apps_open_url_check;
alter table public.apps add constraint apps_open_url_check check (
  open_url is null or (
    char_length(open_url) <= 300
    and open_url ~* '^[a-z][a-z0-9+.-]*://[^[:space:]]+$'
    and open_url !~* '^(javascript|data|vbscript|file|blob|about):'
  )
);
comment on column public.apps.open_url is
  'Lien d''ouverture (deep link) de l''app installée, ex. allococrush://open. Nul = pas de bouton « Ouvrir ».';
