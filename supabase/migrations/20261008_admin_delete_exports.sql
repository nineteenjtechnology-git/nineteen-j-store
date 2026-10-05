-- Nineteen J Store — suppression de téléchargements et réinitialisation des stats (admin uniquement).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front.
-- Les compteurs publics apps.download_count ne sont JAMAIS modifiés par ces fonctions.

-- 1) Le journal expose maintenant la clé complète d'une ligne (admin uniquement) pour pouvoir la supprimer.
create or replace function public.admin_recent_downloads(limit_input integer default 25, offset_input integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  l integer := least(greatest(coalesce(limit_input, 25), 1), 100);
  o integer := greatest(coalesce(offset_input, 0), 0);
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'total', (select count(*) from public.app_download_events),
    'rows', coalesce((
      select jsonb_agg(r order by (r->>'sort') desc)
      from (
        select jsonb_build_object(
          'sort', e.created_at,
          'at', e.created_at,
          'day', e.day,
          'legacy', (e.source is null),
          'app_id', e.app_id,
          'device_id', e.device_id,
          'app', coalesce(a.title, '(app supprimée)'),
          'source', e.source,
          'os', e.os,
          'os_version', e.os_version,
          'model', e.device_model,
          'browser', e.browser,
          'device', left(e.device_id, 6)
        ) as r
        from public.app_download_events e
        left join public.apps a on a.id = e.app_id
        order by e.created_at desc, e.day desc
        limit l offset o
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

-- 2) Supprimer UN téléchargement du journal (et donc des stats).
create or replace function public.admin_delete_download(app_id_input uuid, device_id_input text, day_input date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  delete from public.app_download_events
  where app_id = app_id_input and device_id = device_id_input and day = day_input;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 3) Réinitialiser les statistiques : efface tout le journal des téléchargements et les réponses au sondage.
create or replace function public.admin_reset_stats()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d integer;
  s integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  delete from public.app_download_events where true;
  get diagnostics d = row_count;
  delete from public.survey_responses where true;
  get diagnostics s = row_count;
  return jsonb_build_object('downloads', d, 'survey', s);
end;
$$;

-- Même schéma d'accès que admin_analytics : les JWT Firebase arrivent en rôle anon ; le contrôle réel est
-- private.is_admin() dans le corps (lève 42501 sans JWT admin valide).
revoke all on function public.admin_recent_downloads(integer, integer) from public;
revoke all on function public.admin_delete_download(uuid, text, date) from public;
revoke all on function public.admin_reset_stats() from public;
grant execute on function public.admin_recent_downloads(integer, integer) to anon, authenticated;
grant execute on function public.admin_delete_download(uuid, text, date) to anon, authenticated;
grant execute on function public.admin_reset_stats() to anon, authenticated;
comment on function public.admin_delete_download(uuid, text, date) is
  'Supprime un téléchargement du journal. Réservée aux admins (private.is_admin() dans le corps). EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne touche pas apps.download_count.';
comment on function public.admin_reset_stats() is
  'Efface le journal des téléchargements et les réponses au sondage. Réservée aux admins (private.is_admin() dans le corps). EXECUTE à anon ET authenticated. Ne touche pas apps.download_count.';
