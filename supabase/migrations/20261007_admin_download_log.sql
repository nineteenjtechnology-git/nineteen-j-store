-- Nineteen J Store — journal des téléchargements pour le panneau admin (date, heure, app, appareil).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front.
-- Les anciennes lignes (source nulle) n'ont pas d'heure réelle : created_at y vaut l'heure de la migration
-- du 2026-10-04. Seul le jour (day) est fiable pour elles -> indiqué par legacy = true.
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

-- Même schéma d'accès que admin_analytics : les JWT Firebase arrivent en rôle anon, le contrôle réel
-- est private.is_admin() dans le corps (lève 42501 sans JWT admin valide).
revoke all on function public.admin_recent_downloads(integer, integer) from public;
grant execute on function public.admin_recent_downloads(integer, integer) to anon, authenticated;
comment on function public.admin_recent_downloads(integer, integer) is
  'Journal des téléchargements du panneau admin. Réservée aux admins : contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
