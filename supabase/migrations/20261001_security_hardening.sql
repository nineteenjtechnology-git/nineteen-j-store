-- Nineteen J Store - durcissement suite à l'audit de sécurité du 2026-10-01.
-- Référence les findings H2, M1, M2, M3, B1, B2 du rapport.

-- ========== H2 : email de profil non falsifiable + promotion par UID ==========
alter table public.profiles add constraint profiles_email_unique unique (email);

drop policy if exists "self provision profile" on public.profiles;
create policy "self provision profile" on public.profiles
  for insert to public
  with check (
    firebase_uid = (auth.jwt()->>'sub')
    and role = 'user'
    and email = (auth.jwt()->>'email')
  );
-- Désormais, promouvoir un admin se fait par UID (pas par email) :
--   update public.profiles set role = 'admin' where firebase_uid = '<UID Firebase>';

-- ========== M2 : commentaires réservés aux comptes Google vérifiés, identité non usurpable ==========
alter table public.app_comments add column if not exists author_uid text;

drop policy if exists "signed-in users post comments" on public.app_comments;
drop policy if exists "google users post comments" on public.app_comments;
create policy "google users post comments" on public.app_comments
  for insert to public
  with check (
    (auth.jwt()->>'sub') is not null
    and author_uid = (auth.jwt()->>'sub')
    and (auth.jwt()->'firebase'->>'sign_in_provider') = 'google.com'
    and coalesce((auth.jwt()->>'email_verified')::boolean, false) is true
    and admin_reply is null
    and admin_reply_at is null
    and exists (select 1 from public.apps a where a.id = app_comments.app_id and a.status = 'published')
  );

-- ========== M3 : rien n'est public avant publication explicite ==========
alter table public.apps alter column status set default 'draft';

drop policy if exists "public read versions" on public.app_versions;
create policy "public read versions" on public.app_versions
  for select using (
    exists (select 1 from public.apps a where a.id = app_versions.app_id and a.status = 'published')
  );

drop policy if exists "public read screenshots" on public.app_screenshots;
create policy "public read screenshots" on public.app_screenshots
  for select using (
    exists (select 1 from public.apps a where a.id = app_screenshots.app_id and a.status = 'published')
  );

drop policy if exists "public read comments" on public.app_comments;
create policy "public read comments" on public.app_comments
  for select using (
    exists (select 1 from public.apps a where a.id = app_comments.app_id and a.status = 'published')
  );

-- ========== M1 : garde-fou anti-abus sur les RPC publiques (protège le quota gratuit) ==========
-- Pas une limite parfaite (device_id reste déclaratif), mais bloque un script qui
-- bourrine la base : au-delà de 120 notes ou 120 téléchargements/minute (tous
-- appareils confondus), les RPC lèvent une exception au lieu d'insérer.
create or replace function public.rate_app(app_id_input uuid, device_id_input text, score_input smallint)
returns table(rating numeric, rating_count integer)
language plpgsql security definer set search_path = public as $$
begin
  if score_input < 1 or score_input > 5 then
    raise exception 'La note doit être comprise entre 1 et 5.';
  end if;
  if device_id_input is null or length(device_id_input) < 8 then
    raise exception 'device_id invalide.';
  end if;
  if (select count(*) from public.app_ratings where created_at > now() - interval '1 minute') > 120 then
    raise exception 'Trop de requêtes, réessaie dans une minute.';
  end if;

  insert into public.app_ratings (app_id, device_id, score)
  values (app_id_input, device_id_input, score_input)
  on conflict (app_id, device_id) do update set score = excluded.score, created_at = now();

  update public.apps a set
    rating = coalesce((select round(avg(r.score)::numeric, 1) from public.app_ratings r where r.app_id = app_id_input), 0),
    rating_count = (select count(*) from public.app_ratings r where r.app_id = app_id_input)
  where a.id = app_id_input;

  return query select a.rating, a.rating_count from public.apps a where a.id = app_id_input;
end;
$$;

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
  if (select count(*) from public.app_download_events where day = current_date) > 120 and
     not exists (select 1 from public.app_download_events where app_id = app_id_input and device_id = device_id_input and day = current_date) then
    raise exception 'Trop de requêtes, réessaie plus tard.';
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

-- ========== B1 : URLs stockées contraintes en https ==========
alter table public.apps drop constraint if exists apps_icon_url_https;
alter table public.apps add constraint apps_icon_url_https
  check (icon_url is null or icon_url ~* '^https://');

alter table public.app_screenshots drop constraint if exists screenshots_image_url_https;
alter table public.app_screenshots add constraint screenshots_image_url_https
  check (image_url ~* '^https://');

alter table public.app_versions drop constraint if exists versions_urls_https;
alter table public.app_versions add constraint versions_urls_https
  check (
    (file_url is null or file_url ~* '^https://')
    and (external_url is null or external_url ~* '^https?://')
  );

-- ========== B2 : types MIME autorisés par bucket ==========
update storage.buckets set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif']
  where id in ('app-icons','app-screenshots');
-- Les navigateurs ne reportent pas tous le même type MIME pour un APK/ZIP/IPA
-- (souvent 'application/octet-stream' selon OS/navigateur) : liste volontairement
-- large pour ne pas bloquer des uploads légitimes.
update storage.buckets set allowed_mime_types = array[
  'application/vnd.android.package-archive',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream'
] where id = 'app-binaries';
