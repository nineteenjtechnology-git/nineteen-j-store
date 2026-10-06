-- Nineteen J Store — mode maintenance (rend le site public inaccessible ; le panneau admin reste accessible).
-- Additif et rejouable. Table fermée : lecture publique via get_maintenance() (renvoie NULL si inactif).
create table if not exists public.site_maintenance (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  title text not null default 'Maintenance en cours',
  message text not null default '',
  ends_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.site_maintenance (id) values (1) on conflict (id) do nothing;
alter table public.site_maintenance enable row level security;
revoke all on public.site_maintenance from anon, authenticated;

create or replace function public.get_maintenance()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('title', title, 'message', message, 'ends_at', ends_at)
  from public.site_maintenance where id = 1 and enabled;
$$;

create or replace function public.admin_get_maintenance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  return (select to_jsonb(m) from public.site_maintenance m where id = 1);
end;
$$;

create or replace function public.admin_set_maintenance(enabled_input boolean, title_input text, message_input text, ends_at_input timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text := btrim(coalesce(title_input, ''));
  m text := btrim(coalesce(message_input, ''));
  r public.site_maintenance;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  if t = '' then t := 'Maintenance en cours'; end if;
  if char_length(t) > 80 or char_length(m) > 400 then
    raise exception 'Texte trop long.' using errcode = '22023';
  end if;
  update public.site_maintenance
  set enabled = coalesce(enabled_input, false), title = t, message = m, ends_at = ends_at_input, updated_at = now()
  where id = 1
  returning * into r;
  return to_jsonb(r);
end;
$$;

revoke all on function public.get_maintenance() from public;
revoke all on function public.admin_get_maintenance() from public;
revoke all on function public.admin_set_maintenance(boolean, text, text, timestamptz) from public;
grant execute on function public.get_maintenance() to anon, authenticated;
grant execute on function public.admin_get_maintenance() to anon, authenticated;
grant execute on function public.admin_set_maintenance(boolean, text, text, timestamptz) to anon, authenticated;
comment on function public.admin_set_maintenance(boolean, text, text, timestamptz) is
  'Active/désactive le mode maintenance (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
comment on function public.admin_get_maintenance() is
  'Lit le mode maintenance (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
