-- Nineteen J Store — message d'accueil (affiché à l'entrée du site, piloté depuis le panneau admin).
-- Additif et rejouable. Table fermée au public : lecture via get_site_announcement() (message actif uniquement),
-- écriture via admin_set_announcement() (admin uniquement).
create table if not exists public.site_announcement (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  title text not null default '',
  message text not null default '',
  link_label text,
  link_url text,
  mode text not null default 'once' check (mode in ('once', 'always')),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.site_announcement (id) values (1) on conflict (id) do nothing;
alter table public.site_announcement enable row level security;
revoke all on public.site_announcement from anon, authenticated;

-- Public : renvoie le message seulement s'il est activé et non vide (sinon NULL).
create or replace function public.get_site_announcement()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('version', version, 'title', title, 'message', message,
                            'link_label', link_label, 'link_url', link_url, 'mode', mode)
  from public.site_announcement
  where id = 1 and enabled and (title <> '' or message <> '');
$$;

create or replace function public.admin_get_announcement()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  return (select to_jsonb(a) from public.site_announcement a where id = 1);
end;
$$;

-- `version` augmente quand le contenu change : les visiteurs qui avaient fermé l'ancien message voient le nouveau.
create or replace function public.admin_set_announcement(
  enabled_input boolean, title_input text, message_input text,
  link_label_input text, link_url_input text, mode_input text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text := btrim(coalesce(title_input, ''));
  m text := btrim(coalesce(message_input, ''));
  lu text := nullif(btrim(coalesce(link_url_input, '')), '');
  ll text := nullif(btrim(coalesce(link_label_input, '')), '');
  old public.site_announcement;
  changed boolean;
  r public.site_announcement;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  if char_length(t) > 80 or char_length(m) > 600 or (ll is not null and char_length(ll) > 30) then
    raise exception 'Texte trop long.' using errcode = '22023';
  end if;
  if mode_input is null or mode_input not in ('once', 'always') then
    raise exception 'Mode invalide.' using errcode = '22023';
  end if;
  if coalesce(enabled_input, false) and t = '' and m = '' then
    raise exception 'Écris un titre ou un message avant d''activer.' using errcode = '22023';
  end if;
  -- Lien : chemin du site (/…) ou https://… ; jamais javascript:, data:, etc.
  if lu is not null and (char_length(lu) > 300
      or not (lu ~ '^/[^/[:space:]][^[:space:]]*$' or lu = '/' or lu ~* '^https://[^[:space:]]+$')) then
    raise exception 'Lien invalide : utilise un chemin du site (/…) ou une adresse https://…' using errcode = '22023';
  end if;
  if lu is null then ll := null; elsif ll is null then ll := 'Voir'; end if;

  select * into old from public.site_announcement where id = 1;
  changed := (old.title, old.message, old.link_label, old.link_url) is distinct from (t, m, ll, lu);

  update public.site_announcement
  set enabled = coalesce(enabled_input, false), title = t, message = m, link_label = ll, link_url = lu,
      mode = mode_input, version = case when changed then version + 1 else version end, updated_at = now()
  where id = 1
  returning * into r;
  return to_jsonb(r);
end;
$$;

revoke all on function public.get_site_announcement() from public;
revoke all on function public.admin_get_announcement() from public;
revoke all on function public.admin_set_announcement(boolean, text, text, text, text, text) from public;
grant execute on function public.get_site_announcement() to anon, authenticated;
grant execute on function public.admin_get_announcement() to anon, authenticated;
grant execute on function public.admin_set_announcement(boolean, text, text, text, text, text) to anon, authenticated;
comment on function public.admin_set_announcement(boolean, text, text, text, text, text) is
  'Met à jour le message d''accueil (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
comment on function public.admin_get_announcement() is
  'Lit le message d''accueil (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
