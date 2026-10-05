-- Nineteen J Store — notifications Web Push (gratuit, natif navigateur).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front.
-- Les tables sont fermées à anon/authenticated (RLS sans policy + REVOKE) : tout passe par les fonctions
-- ci-dessous ou par l'Edge Function `send-push` (clé service). Les clés VAPID ne quittent jamais la base.

-- 1) Clés VAPID (une seule ligne, générée par l'Edge Function au premier passage de l'admin)
create table if not exists public.push_config (
  id integer primary key check (id = 1),
  public_key text not null,
  private_key text not null,
  subject text not null,
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

-- 2) Abonnements des visiteurs
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_device_idx on public.push_subscriptions (device_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- 3) Historique des envois
create table if not exists public.push_messages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  url text not null default '/',
  audience text not null,
  recipients integer not null default 0,
  sent integer not null default 0,
  failed integer not null default 0,
  removed integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.push_messages enable row level security;
revoke all on public.push_messages from anon, authenticated;

-- 4) Clé publique VAPID (publique par nature) pour le navigateur
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = public as $$
  select public_key from public.push_config where id = 1;
$$;

-- 5) Enregistrement d'un abonnement. Contrôles stricts : seul un vrai service push est accepté
--    (liste blanche d'hôtes), ce qui empêche d'utiliser l'Edge Function pour atteindre une URL arbitraire (SSRF).
create or replace function public.register_push_subscription(endpoint_input text, p256dh_input text, auth_input text, device_input text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if endpoint_input is null or char_length(endpoint_input) > 1000
     or endpoint_input !~* '^https://([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)/[^[:space:]]{10,}$' then
    raise exception 'Abonnement invalide.' using errcode = '22023';
  end if;
  if p256dh_input is null or p256dh_input !~ '^[A-Za-z0-9_-]{80,100}$'
     or auth_input is null or auth_input !~ '^[A-Za-z0-9_-]{20,30}$' then
    raise exception 'Clés d''abonnement invalides.' using errcode = '22023';
  end if;
  if device_input is not null and char_length(device_input) > 100 then
    raise exception 'Identifiant appareil invalide.' using errcode = '22023';
  end if;
  if (select count(*) from public.push_subscriptions) > 50000
     and not exists (select 1 from public.push_subscriptions where endpoint = endpoint_input) then
    raise exception 'Limite d''abonnements atteinte.' using errcode = '54000';
  end if;

  insert into public.push_subscriptions (endpoint, p256dh, auth, device_id)
  values (endpoint_input, p256dh_input, auth_input, device_input)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, device_id = excluded.device_id, updated_at = now();
end;
$$;

create or replace function public.unregister_push_subscription(endpoint_input text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = endpoint_input;
$$;

-- 6) Utilisée par l'Edge Function pour vérifier que l'appelant (jeton Firebase) est admin
create or replace function public.am_i_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(private.is_admin(), false);
$$;

-- 7) Vue d'ensemble pour le panneau admin
create or replace function public.admin_push_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'configured', exists (select 1 from public.push_config where id = 1),
    'subscribers', (select count(*) from public.push_subscriptions),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'slug', a.slug, 'subscribers', coalesce(c.n, 0)) order by a.title)
      from public.apps a
      left join (
        select e.app_id, count(distinct s.id) as n
        from public.push_subscriptions s
        join public.app_download_events e on e.device_id = s.device_id
        group by e.app_id
      ) c on c.app_id = a.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.created_at desc)
      from (select id, title, body, url, audience, recipients, sent, failed, removed, created_at
            from public.push_messages order by created_at desc limit 10) m
    ), '[]'::jsonb)
  );
end;
$$;

-- Accès : même schéma que les autres fonctions admin (JWT Firebase en rôle anon ; contrôle réel = private.is_admin()).
revoke all on function public.push_public_key() from public;
revoke all on function public.register_push_subscription(text, text, text, text) from public;
revoke all on function public.unregister_push_subscription(text) from public;
revoke all on function public.am_i_admin() from public;
revoke all on function public.admin_push_overview() from public;
grant execute on function public.push_public_key() to anon, authenticated;
grant execute on function public.register_push_subscription(text, text, text, text) to anon, authenticated;
grant execute on function public.unregister_push_subscription(text) to anon, authenticated;
grant execute on function public.am_i_admin() to anon, authenticated;
grant execute on function public.admin_push_overview() to anon, authenticated;
comment on function public.admin_push_overview() is
  'Vue d''ensemble des notifications push (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
