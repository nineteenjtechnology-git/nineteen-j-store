-- Nineteen J Store — statistiques anonymes de téléchargement + sondage général.
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front : l'ancien front
-- (appel à 2 arguments) continue de fonctionner grâce aux valeurs par défaut.

-- ========== 1) Téléchargements : source du lien + infos techniques non identifiantes ==========
alter table public.app_download_events
  add column if not exists created_at   timestamptz not null default now(),
  add column if not exists source       text,
  add column if not exists os           text,
  add column if not exists os_version   text,
  add column if not exists browser      text,
  add column if not exists device_model text,
  add column if not exists lang         text,
  add column if not exists timezone     text,
  add column if not exists screen       text,
  add column if not exists display_mode text,
  add column if not exists network      text;

create index if not exists app_download_events_created_idx
  on public.app_download_events (created_at);

-- Remplace la signature à 2 arguments (sinon ambiguïté de surcharge côté PostgREST).
drop function if exists public.increment_download_count(uuid, text);

create or replace function public.increment_download_count(
  app_id_input uuid,
  device_id_input text,
  source_input text default null,
  meta_input jsonb default null
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
  total integer;
  src text;
begin
  if device_id_input is null or char_length(device_id_input) < 8 or char_length(device_id_input) > 100 then
    raise exception 'device_id invalide.';
  end if;

  -- Garde-fou anti-abus : plus de 120 nouveaux comptages dans la dernière MINUTE (tous
  -- appareils confondus). L'ancienne version comptait par jour, ce qui figeait le compteur
  -- au-delà de 120 téléchargements quotidiens. Un appareil déjà compté aujourd'hui n'est
  -- jamais bloqué (il ne réinsère rien).
  if (select count(*) from public.app_download_events where created_at > now() - interval '1 minute') > 120
     and not exists (
       select 1 from public.app_download_events
       where app_id = app_id_input and device_id = device_id_input and day = current_date
     ) then
    raise exception 'Trop de requêtes, réessaie dans une minute.';
  end if;

  -- Source : liste blanche de caractères, sinon "direct".
  src := case when source_input ~ '^[a-z0-9_.-]{1,40}$' then source_input else 'direct' end;

  insert into public.app_download_events
    (app_id, device_id, source, os, os_version, browser, device_model, lang, timezone, screen, display_mode, network)
  values (
    app_id_input, device_id_input, src,
    left(meta_input->>'os', 20),
    left(meta_input->>'os_version', 20),
    left(meta_input->>'browser', 20),
    left(meta_input->>'model', 40),
    left(meta_input->>'lang', 12),
    left(meta_input->>'tz', 40),
    left(meta_input->>'screen', 12),
    left(meta_input->>'mode', 12),
    left(meta_input->>'net', 8)
  )
  on conflict do nothing;
  get diagnostics inserted = row_count;

  if inserted > 0 then
    update public.apps set download_count = download_count + 1
    where id = app_id_input and status = 'published'
    returning download_count into total;
  else
    select download_count into total from public.apps where id = app_id_input;
  end if;
  return coalesce(total, 0);
end;
$$;

revoke all on function public.increment_download_count(uuid, text, text, jsonb) from public;
grant execute on function public.increment_download_count(uuid, text, text, jsonb) to anon, authenticated;
comment on function public.increment_download_count(uuid, text, text, jsonb) is
  'RPC PUBLIQUE VOLONTAIRE (security definer). Ne pas retirer EXECUTE à anon/authenticated : les téléchargements ne seraient plus comptés. 1 comptage max par appareil, app et jour. Stocke la source du lien et des infos techniques anonymes.';

-- ========== 2) Sondage général (valable quelle que soit l'app téléchargée) ==========
create table if not exists public.survey_responses (
  device_id  text primary key check (char_length(device_id) between 8 and 100),
  app_id     uuid references public.apps(id) on delete set null,
  statut     text check (statut in ('eleve','etudiant','enseignant','professionnel','autre')),
  usage      text check (usage in ('etudes','travail','loisirs','autre')),
  decouverte text check (decouverte in ('whatsapp','facebook','tiktok_instagram','ami','autre')),
  ville      text check (ville is null or char_length(ville) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- RLS activée SANS policy publique + aucun droit direct : écriture uniquement via submit_survey().
alter table public.survey_responses enable row level security;
revoke all on public.survey_responses from anon, authenticated;

create or replace function public.submit_survey(
  app_id_input uuid,
  device_id_input text,
  answers_input jsonb
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_statut text;
  v_usage text;
  v_decouverte text;
  v_ville text;
  v_app uuid;
begin
  if device_id_input is null or char_length(device_id_input) < 8 or char_length(device_id_input) > 100 then
    raise exception 'device_id invalide.';
  end if;
  if answers_input is null or jsonb_typeof(answers_input) <> 'object' then
    raise exception 'Réponses invalides.';
  end if;
  if (select count(*) from public.survey_responses where updated_at > now() - interval '1 minute') > 60 then
    raise exception 'Trop de requêtes, réessaie dans une minute.';
  end if;

  -- Valeurs hors liste ignorées (null) plutôt que de faire échouer l'envoi.
  v_statut := answers_input->>'statut';
  v_statut := case when v_statut in ('eleve','etudiant','enseignant','professionnel','autre') then v_statut end;
  v_usage := answers_input->>'usage';
  v_usage := case when v_usage in ('etudes','travail','loisirs','autre') then v_usage end;
  v_decouverte := answers_input->>'decouverte';
  v_decouverte := case when v_decouverte in ('whatsapp','facebook','tiktok_instagram','ami','autre') then v_decouverte end;
  v_ville := nullif(left(btrim(regexp_replace(coalesce(answers_input->>'ville', ''), '[[:cntrl:]]', '', 'g')), 60), '');

  if v_statut is null and v_usage is null and v_decouverte is null and v_ville is null then
    return false;
  end if;

  select id into v_app from public.apps where id = app_id_input and status = 'published';

  insert into public.survey_responses (device_id, app_id, statut, usage, decouverte, ville)
  values (device_id_input, v_app, v_statut, v_usage, v_decouverte, v_ville)
  on conflict (device_id) do update set
    app_id = excluded.app_id,
    statut = excluded.statut,
    usage = excluded.usage,
    decouverte = excluded.decouverte,
    ville = excluded.ville,
    updated_at = now();
  return true;
end;
$$;

revoke all on function public.submit_survey(uuid, text, jsonb) from public;
grant execute on function public.submit_survey(uuid, text, jsonb) to anon, authenticated;
comment on function public.submit_survey(uuid, text, jsonb) is
  'RPC PUBLIQUE VOLONTAIRE (security definer). Ne pas retirer EXECUTE à anon/authenticated : le sondage cesserait de fonctionner. Une réponse par appareil, valeurs validées par liste blanche.';

-- ========== 3) Statistiques pour le panneau admin (réservé aux admins) ==========
create or replace function public.admin_analytics(days_input integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  d integer := least(greatest(coalesce(days_input, 30), 1), 365);
  since timestamptz := now() - make_interval(days => d);
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', d,
    'downloads', (select count(*) from public.app_download_events where created_at >= since),
    'devices', (select count(distinct device_id) from public.app_download_events where created_at >= since),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('k', day::text, 'n', n) order by day)
      from (select created_at::date as day, count(*) as n from public.app_download_events where created_at >= since group by 1) t
    ), '[]'::jsonb),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select coalesce(source, 'direct') as k, count(*) as n from public.app_download_events where created_at >= since group by 1 order by n desc limit 10) t
    ), '[]'::jsonb),
    'by_os', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select coalesce(os, 'inconnu') || coalesce(' ' || os_version, '') as k, count(*) as n from public.app_download_events where created_at >= since group by 1 order by n desc limit 10) t
    ), '[]'::jsonb),
    'by_browser', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select coalesce(browser, 'inconnu') as k, count(*) as n from public.app_download_events where created_at >= since group by 1 order by n desc limit 10) t
    ), '[]'::jsonb),
    'by_model', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select device_model as k, count(*) as n from public.app_download_events where created_at >= since and device_model is not null group by 1 order by n desc limit 10) t
    ), '[]'::jsonb),
    'by_lang', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select coalesce(lang, 'inconnu') as k, count(*) as n from public.app_download_events where created_at >= since group by 1 order by n desc limit 10) t
    ), '[]'::jsonb),
    'by_network', coalesce((
      select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
      from (select network as k, count(*) as n from public.app_download_events where created_at >= since and network is not null group by 1 order by n desc limit 6) t
    ), '[]'::jsonb),
    'survey', jsonb_build_object(
      'total', (select count(*) from public.survey_responses),
      'statut', coalesce((
        select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
        from (select statut as k, count(*) as n from public.survey_responses where statut is not null group by 1) t
      ), '[]'::jsonb),
      'usage', coalesce((
        select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
        from (select usage as k, count(*) as n from public.survey_responses where usage is not null group by 1) t
      ), '[]'::jsonb),
      'decouverte', coalesce((
        select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
        from (select decouverte as k, count(*) as n from public.survey_responses where decouverte is not null group by 1) t
      ), '[]'::jsonb),
      'villes', coalesce((
        select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k)
        from (select lower(ville) as k, count(*) as n from public.survey_responses where ville is not null group by 1 order by n desc limit 10) t
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- Les JWT Firebase (Third-Party Auth) n'ont pas de claim "role" : PostgREST les exécute en rôle anon.
-- EXECUTE doit donc être accordé à anon ET authenticated ; le contrôle d'accès réel est dans le corps
-- de la fonction (private.is_admin() : sub Firebase d'un profil admin). Sans JWT valide, il lève 42501.
revoke all on function public.admin_analytics(integer) from public;
grant execute on function public.admin_analytics(integer) to anon, authenticated;
comment on function public.admin_analytics(integer) is
  'Statistiques du panneau admin. Réservée aux admins : contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated, car les JWT Firebase arrivent en rôle anon (pas de claim role). Ne pas retirer.';