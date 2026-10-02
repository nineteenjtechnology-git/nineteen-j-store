-- Nineteen J Store - notation + commentaires (déjà appliqué en direct sur le projet
-- via l'outil MCP le 2026-09-29, suite aux retours de test). Ce fichier versionne
-- le changement pour un nouvel environnement.

alter table public.apps add column if not exists rating_count integer not null default 0;

create table public.app_ratings (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  device_id text not null,
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (app_id, device_id)
);
-- RLS activée SANS policy publique : uniquement accessible via les RPC security
-- definer ci-dessous (empêche de lire les device_id ou de voter en direct sur la table).
alter table public.app_ratings enable row level security;

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
grant execute on function public.rate_app(uuid, text, smallint) to anon, authenticated;

create or replace function public.get_my_rating(app_id_input uuid, device_id_input text)
returns smallint
language sql stable security definer set search_path = public as $$
  select score from public.app_ratings where app_id = app_id_input and device_id = device_id_input;
$$;
grant execute on function public.get_my_rating(uuid, text) to anon, authenticated;

create table public.app_comments (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint author_name_len check (char_length(trim(author_name)) between 1 and 60),
  constraint body_len check (char_length(trim(body)) between 1 and 1000)
);
create index idx_comments_app on public.app_comments(app_id);
alter table public.app_comments enable row level security;

create policy "public read comments" on public.app_comments for select using (true);
create policy "public post comments" on public.app_comments for insert to public with check (true);
create policy "admin delete comments" on public.app_comments for delete to public using (private.is_admin());
