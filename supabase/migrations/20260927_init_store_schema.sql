-- Nineteen J Store - schéma Supabase (architecture 100% gratuite)
-- Déjà appliqué sur le projet "nineteen-j-store" (rrlayjervibobxiucbuu) via l'outil MCP.
-- Aucun backend : le client Firebase-authentifié parle directement à Supabase, RLS fait
-- toute l'autorisation (voir private.is_admin()). Ce fichier sert de référence versionnée
-- pour un nouvel environnement (staging, etc.).

create extension if not exists "pgcrypto";

-- ========== TABLES ==========

create table public.profiles (
  firebase_uid text primary key,
  email text not null,
  display_name text,
  role text not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  icon_name text default 'grid',
  created_at timestamptz not null default now()
);

create table public.apps (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  short_description text not null,
  full_description text,
  category_id uuid references public.categories(id) on delete set null,
  platform text not null check (platform in ('android','ios','web','cross_platform')),
  developer_name text not null default 'Nineteen J Games',
  icon_url text,
  featured boolean not null default false,
  download_count integer not null default 0,
  rating numeric(2,1) not null default 0 check (rating >= 0 and rating <= 5),
  status text not null default 'published' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.app_versions (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  version_number text not null,
  changelog text,
  file_url text,
  external_url text,
  file_size bigint,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.app_screenshots (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  image_url text not null,
  display_order integer not null default 0
);

create index idx_apps_category on public.apps(category_id);
create index idx_apps_platform on public.apps(platform);
create index idx_apps_featured on public.apps(featured) where featured = true;
create index idx_versions_app on public.app_versions(app_id);
create index idx_screenshots_app on public.app_screenshots(app_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger trg_apps_updated_at before update on public.apps
  for each row execute function public.set_updated_at();

-- ========== RLS ==========

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.apps enable row level security;
alter table public.app_versions enable row level security;
alter table public.app_screenshots enable row level security;

-- Lecture publique (anon + authenticated)
create policy "public read categories" on public.categories for select using (true);
create policy "public read apps" on public.apps for select using (status = 'published');
create policy "public read versions" on public.app_versions for select using (true);
create policy "public read screenshots" on public.app_screenshots for select using (true);

-- RPC publique sûre : incrémente un compteur, ne lit/n'écrit rien d'autre
create or replace function public.increment_download_count(app_id_input uuid)
returns void language sql security definer set search_path = public as $$
  update public.apps set download_count = download_count + 1 where id = app_id_input;
$$;
grant execute on function public.increment_download_count(uuid) to anon, authenticated;

-- ---------- Autorisation admin via Firebase Auth (Third-Party Auth) ----------
-- Le client Supabase du panneau admin envoie le ID token Firebase comme JWT
-- (voir public/js/supabase-admin.js). `auth.jwt()->>'sub'` correspond alors à
-- l'UID Firebase. is_admin() est dans un schéma "private" NON exposé par l'API
-- REST (seul "public" l'est) : elle reste utilisable par les policies RLS mais
-- n'est pas appelable en RPC publique.
create schema if not exists private;

create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where firebase_uid = auth.jwt()->>'sub'
      and role = 'admin'
  );
$$;

-- Écriture réservée aux admins sur les tables de contenu
create policy "admin write categories" on public.categories
  for all to public using (private.is_admin()) with check (private.is_admin());
create policy "admin write apps" on public.apps
  for all to public using (private.is_admin()) with check (private.is_admin());
create policy "admin write app_versions" on public.app_versions
  for all to public using (private.is_admin()) with check (private.is_admin());
create policy "admin write app_screenshots" on public.app_screenshots
  for all to public using (private.is_admin()) with check (private.is_admin());

-- profiles : chacun peut lire son propre profil (vérifier son rôle côté client) et
-- créer SON PROPRE profil avec role='user' uniquement - impossible de s'auto-
-- promouvoir admin. La promotion est un geste manuel (voir README).
create policy "read own profile" on public.profiles
  for select to public using (firebase_uid = auth.jwt()->>'sub');
create policy "self provision profile" on public.profiles
  for insert to public with check (firebase_uid = auth.jwt()->>'sub' and role = 'user');

-- ========== STORAGE ==========

insert into storage.buckets (id, name, public) values
  ('app-icons', 'app-icons', true),
  ('app-screenshots', 'app-screenshots', true),
  ('app-binaries', 'app-binaries', true)
on conflict (id) do nothing;

create policy "public read app-icons" on storage.objects for select using (bucket_id = 'app-icons');
create policy "public read app-screenshots" on storage.objects for select using (bucket_id = 'app-screenshots');
create policy "public read app-binaries" on storage.objects for select using (bucket_id = 'app-binaries');

create policy "admin insert store buckets" on storage.objects
  for insert to public
  with check (bucket_id in ('app-icons','app-screenshots','app-binaries') and private.is_admin());
create policy "admin update store buckets" on storage.objects
  for update to public
  using (bucket_id in ('app-icons','app-screenshots','app-binaries') and private.is_admin());
create policy "admin delete store buckets" on storage.objects
  for delete to public
  using (bucket_id in ('app-icons','app-screenshots','app-binaries') and private.is_admin());

-- Pour promouvoir le premier administrateur (après sa 1ère connexion sur /admin,
-- qui crée automatiquement son profil 'user') :
-- update public.profiles set role = 'admin' where email = 'ton-email@example.com';
