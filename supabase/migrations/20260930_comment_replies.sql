-- Nineteen J Store - réponses admin aux avis (déjà appliqué en direct via l'outil MCP).

alter table public.app_comments add column if not exists admin_reply text;
alter table public.app_comments add column if not exists admin_reply_at timestamptz;

create policy "admin update comments" on public.app_comments
  for update to public using (private.is_admin()) with check (private.is_admin());
