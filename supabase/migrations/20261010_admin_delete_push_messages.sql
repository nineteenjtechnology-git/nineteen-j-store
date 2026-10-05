-- Nineteen J Store — effacer l'historique des notifications envoyées (admin uniquement).
-- Additif et rejouable. Ne supprime que la trace dans le panneau admin : une notification déjà reçue
-- sur un téléphone ne peut pas être rappelée.
create or replace function public.admin_delete_push_message(message_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  delete from public.push_messages where id = message_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.admin_clear_push_history()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  delete from public.push_messages where true;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.admin_delete_push_message(uuid) from public;
revoke all on function public.admin_clear_push_history() from public;
grant execute on function public.admin_delete_push_message(uuid) to anon, authenticated;
grant execute on function public.admin_clear_push_history() to anon, authenticated;
comment on function public.admin_delete_push_message(uuid) is
  'Supprime une ligne de l''historique push (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
comment on function public.admin_clear_push_history() is
  'Vide l''historique push (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
