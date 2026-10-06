-- Nineteen J Store — notifications push programmées (gratuit : pg_cron + pg_net + Edge Function send-push).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front et la nouvelle version de send-push.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Secret partagé entre la tâche planifiée et l'Edge Function (jamais exposé au navigateur).
alter table public.push_config
  add column if not exists cron_secret text not null
  default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

create table if not exists public.push_scheduled (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  url text not null default '/',
  audience_type text not null default 'all' check (audience_type in ('all', 'app')),
  app_id uuid references public.apps(id) on delete cascade,
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed', 'missed')),
  result jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  check (audience_type <> 'app' or app_id is not null)
);
create index if not exists push_scheduled_due_idx on public.push_scheduled (status, send_at);
alter table public.push_scheduled enable row level security;
revoke all on public.push_scheduled from anon, authenticated;

-- Programmer un envoi (admin).
create or replace function public.admin_schedule_push(
  title_input text, body_input text, url_input text, audience_type_input text, app_id_input uuid, send_at_input timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text := btrim(coalesce(title_input, ''));
  b text := btrim(coalesce(body_input, ''));
  u text := coalesce(nullif(btrim(coalesce(url_input, '')), ''), '/');
  r public.push_scheduled;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  if t = '' or char_length(t) > 65 then raise exception 'Titre requis (65 caractères max).' using errcode = '22023'; end if;
  if b = '' or char_length(b) > 180 then raise exception 'Message requis (180 caractères max).' using errcode = '22023'; end if;
  if char_length(u) > 300 or not (u = '/' or u ~ '^/[^/[:space:]][^[:space:]]*$') then
    raise exception 'Lien invalide (chemin du site attendu).' using errcode = '22023';
  end if;
  if audience_type_input not in ('all', 'app') then raise exception 'Audience invalide.' using errcode = '22023'; end if;
  if audience_type_input = 'app' and not exists (select 1 from public.apps where id = app_id_input) then
    raise exception 'App introuvable.' using errcode = '22023';
  end if;
  if send_at_input is null or send_at_input < now() - interval '1 minute' then
    raise exception 'Choisis une date et une heure dans le futur.' using errcode = '22023';
  end if;
  if send_at_input > now() + interval '1 year' then
    raise exception 'Date trop lointaine (1 an maximum).' using errcode = '22023';
  end if;
  if (select count(*) from public.push_scheduled where status = 'pending') >= 50 then
    raise exception 'Trop d''envois en attente (50 maximum).' using errcode = '54000';
  end if;

  insert into public.push_scheduled (title, body, url, audience_type, app_id, send_at)
  values (t, b, u, audience_type_input, case when audience_type_input = 'app' then app_id_input end, send_at_input)
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- Liste (admin) : en attente d'abord (les plus proches), puis les derniers traités.
create or replace function public.admin_list_scheduled_push()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.pending desc, case when x.pending then x.send_at end asc, x.send_at desc)
    from (
      select s.id, s.title, s.body, s.url, s.audience_type, s.app_id, a.title as app_title, s.send_at, s.status,
             s.result, s.sent_at, (s.status in ('pending', 'sending')) as pending
      from public.push_scheduled s left join public.apps a on a.id = s.app_id
      order by (s.status in ('pending', 'sending')) desc, s.send_at desc
      limit 30
    ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_cancel_scheduled_push(scheduled_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  update public.push_scheduled set status = 'cancelled' where id = scheduled_id and status = 'pending';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Effacer une ligne déjà traitée (pas celles en attente ni en cours d'envoi).
create or replace function public.admin_delete_scheduled_push(scheduled_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_admin() then
    raise exception 'Accès réservé aux administrateurs.' using errcode = '42501';
  end if;
  delete from public.push_scheduled where id = scheduled_id and status not in ('pending', 'sending');
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz) from public;
revoke all on function public.admin_list_scheduled_push() from public;
revoke all on function public.admin_cancel_scheduled_push(uuid) from public;
revoke all on function public.admin_delete_scheduled_push(uuid) from public;
grant execute on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz) to anon, authenticated;
grant execute on function public.admin_list_scheduled_push() to anon, authenticated;
grant execute on function public.admin_cancel_scheduled_push(uuid) to anon, authenticated;
grant execute on function public.admin_delete_scheduled_push(uuid) to anon, authenticated;
comment on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz) is
  'Programme un envoi push (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';

-- Tâche planifiée : chaque minute, si un envoi est dû, appelle l'Edge Function (qui vérifie le secret).
select cron.unschedule('send-due-push') where exists (select 1 from cron.job where jobname = 'send-due-push');
select cron.schedule(
  'send-due-push',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://rrlayjervibobxiucbuu.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select cron_secret from public.push_config where id = 1)),
    body := '{"action":"run_due"}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (select 1 from public.push_scheduled where status = 'pending' and send_at <= now())
    and exists (select 1 from public.push_config where id = 1);
  $job$
);
