-- Nineteen J Store — répétition automatique des notifications programmées (quotidienne, hebdomadaire, mensuelle).
-- Additif et rejouable. À appliquer AVANT de déployer le nouveau front et la nouvelle version de send-push.
alter table public.push_scheduled
  add column if not exists repeat_every text not null default 'none' check (repeat_every in ('none', 'daily', 'weekly', 'monthly')),
  add column if not exists repeat_until timestamptz,
  add column if not exists first_send_at timestamptz,
  add column if not exists run_count integer not null default 0;
update public.push_scheduled set first_send_at = send_at where first_send_at is null;

-- Nouvelle signature (2 paramètres de répétition) : l'ancienne est retirée.
drop function if exists public.admin_schedule_push(text, text, text, text, uuid, timestamptz);
create or replace function public.admin_schedule_push(
  title_input text, body_input text, url_input text, audience_type_input text, app_id_input uuid, send_at_input timestamptz,
  repeat_input text default 'none', repeat_until_input timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text := btrim(coalesce(title_input, ''));
  b text := btrim(coalesce(body_input, ''));
  u text := coalesce(nullif(btrim(coalesce(url_input, '')), ''), '/');
  rep text := coalesce(repeat_input, 'none');
  until_at timestamptz := repeat_until_input;
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
  if rep not in ('none', 'daily', 'weekly', 'monthly') then raise exception 'Répétition invalide.' using errcode = '22023'; end if;
  if rep = 'none' then
    until_at := null;
  elsif until_at is not null and (until_at <= send_at_input or until_at > send_at_input + interval '2 years') then
    raise exception 'La date de fin de répétition doit suivre le premier envoi (2 ans maximum).' using errcode = '22023';
  end if;
  if (select count(*) from public.push_scheduled where status = 'pending') >= 50 then
    raise exception 'Trop d''envois en attente (50 maximum).' using errcode = '54000';
  end if;

  insert into public.push_scheduled (title, body, url, audience_type, app_id, send_at, first_send_at, repeat_every, repeat_until)
  values (t, b, u, audience_type_input, case when audience_type_input = 'app' then app_id_input end,
          send_at_input, send_at_input, rep, until_at)
  returning * into r;
  return to_jsonb(r);
end;
$$;

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
             s.result, s.sent_at, s.repeat_every, s.repeat_until, s.run_count, (s.status in ('pending', 'sending')) as pending
      from public.push_scheduled s left join public.apps a on a.id = s.app_id
      order by (s.status in ('pending', 'sending')) desc, s.send_at desc
      limit 30
    ) x
  ), '[]'::jsonb);
end;
$$;

-- Appelée uniquement par l'Edge Function (clé service) après un envoi : calcule la prochaine échéance (> maintenant)
-- depuis la date du PREMIER envoi (pas de dérive : le 31 revient le 31 quand le mois le permet) ou clôt la série.
create or replace function public.reschedule_push(scheduled_id uuid, result_input jsonb, sent_input boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.push_scheduled;
  base timestamptz;
  step interval;
  nxt timestamptz;
  k integer := 0;
  inc integer := case when sent_input then 1 else 0 end;
begin
  select * into r from public.push_scheduled where id = scheduled_id and status = 'sending' for update;
  if not found then return; end if;

  step := case r.repeat_every when 'daily' then interval '1 day' when 'weekly' then interval '7 days'
                              when 'monthly' then interval '1 month' else null end;
  if step is null then
    update public.push_scheduled
    set status = case when sent_input then 'sent' else 'missed' end, result = result_input,
        sent_at = case when sent_input then now() else sent_at end, run_count = run_count + inc
    where id = scheduled_id;
    return;
  end if;

  base := coalesce(r.first_send_at, r.send_at);
  loop
    k := k + 1;
    nxt := base + step * k;
    exit when nxt > now() or k > 4000;
  end loop;

  if nxt <= now() then
    update public.push_scheduled set status = 'failed', result = jsonb_build_object('error', 'prochaine échéance introuvable') where id = scheduled_id;
  elsif r.repeat_until is not null and nxt > r.repeat_until then
    update public.push_scheduled
    set status = 'sent', result = result_input, sent_at = case when sent_input then now() else sent_at end, run_count = run_count + inc
    where id = scheduled_id;
  else
    update public.push_scheduled
    set status = 'pending', send_at = nxt, result = result_input,
        sent_at = case when sent_input then now() else sent_at end, run_count = run_count + inc
    where id = scheduled_id;
  end if;
end;
$$;

revoke all on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz, text, timestamptz) from public;
revoke all on function public.admin_list_scheduled_push() from public;
revoke all on function public.reschedule_push(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz, text, timestamptz) to anon, authenticated;
grant execute on function public.admin_list_scheduled_push() to anon, authenticated;
grant execute on function public.reschedule_push(uuid, jsonb, boolean) to service_role;
comment on function public.admin_schedule_push(text, text, text, text, uuid, timestamptz, text, timestamptz) is
  'Programme un envoi push, éventuellement répété (admin). Contrôle private.is_admin() dans le corps. EXECUTE à anon ET authenticated (JWT Firebase en rôle anon). Ne pas retirer.';
