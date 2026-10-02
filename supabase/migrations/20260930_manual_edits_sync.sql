-- Nineteen J Store - synchronise les migrations versionnées avec des modifications
-- faites À LA MAIN sur le projet Supabase (Dashboard / SQL Editor), le 2026-09-30.
-- Écrit de façon idempotente (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS)
-- pour pouvoir être rejoué sans erreur, y compris sur cette base où c'est déjà en place.

-- ========== Nouvelles colonnes ==========
alter table public.categories add column if not exists display_order integer not null default 0;
alter table public.apps add column if not exists website_url text;
alter table public.apps drop constraint if exists apps_website_url_check;
alter table public.apps add constraint apps_website_url_check
  check (website_url is null or website_url ~* '^https?://');

-- ========== Anti-doublon des téléchargements (1 par appareil par jour) ==========
create table if not exists public.app_download_events (
  app_id uuid not null references public.apps(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 8 and 100),
  day date not null default current_date,
  primary key (app_id, device_id, day)
);
-- RLS activée SANS policy publique : uniquement modifiable via la RPC
-- security definer increment_download_count() ci-dessous.
alter table public.app_download_events enable row level security;

create or replace function public.increment_download_count(app_id_input uuid, device_id_input text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  inserted integer;
  total integer;
begin
  if device_id_input is null or char_length(device_id_input) < 8 or char_length(device_id_input) > 100 then
    raise exception 'device_id invalide.';
  end if;

  insert into public.app_download_events (app_id, device_id)
  values (app_id_input, device_id_input)
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
-- Remplace l'ancienne signature à 1 argument (incompatible, donc dépréciée)
drop function if exists public.increment_download_count(uuid);
grant execute on function public.increment_download_count(uuid, text) to anon, authenticated;

-- ========== Une seule version "courante" par app, appliqué par trigger ==========
create or replace function public.single_current_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_current then
    update public.app_versions set is_current = false
    where app_id = new.app_id and id <> new.id and is_current;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_single_current_version on public.app_versions;
create trigger trg_single_current_version
  after insert or update on public.app_versions
  for each row execute function public.single_current_version();

-- ========== Commentaires : exige désormais d'être connecté (anti-spam) ==========
-- Remplace "public post comments" (n'importe qui, sans compte) par une policy qui
-- exige un JWT Firebase valide (auth.jwt()->>'sub' non nul) - donc un visiteur
-- connecté (Google/Email via Firebase Auth), mais pas nécessairement admin.
-- Empêche aussi un visiteur de s'auto-écrire une "réponse admin".
drop policy if exists "public post comments" on public.app_comments;
drop policy if exists "signed-in users post comments" on public.app_comments;
create policy "signed-in users post comments" on public.app_comments
  for insert to public
  with check (
    (select auth.jwt()->>'sub') is not null
    and admin_reply is null
    and admin_reply_at is null
    and exists (select 1 from public.apps a where a.id = app_comments.app_id and a.status = 'published')
  );

-- ========== Storage : lecture publique via l'URL publique du bucket (bucket.public
-- = true), pas besoin de policy RLS SELECT dédiée - simplifié en conséquence.
-- On garde uniquement les policies nécessaires aux opérations admin authentifiées. ==========
drop policy if exists "public read app-icons" on storage.objects;
drop policy if exists "public read app-screenshots" on storage.objects;
drop policy if exists "public read app-binaries" on storage.objects;
drop policy if exists "admin select store buckets" on storage.objects;
create policy "admin select store buckets" on storage.objects
  for select to public
  using (bucket_id in ('app-icons','app-screenshots','app-binaries') and private.is_admin());

-- ========== Limites de taille des buckets (déjà posées à la main, documentées ici) ==========
update storage.buckets set file_size_limit = 5242880 where id in ('app-icons','app-screenshots');   -- 5 Mo
update storage.buckets set file_size_limit = 52428800 where id = 'app-binaries';                     -- 50 Mo
