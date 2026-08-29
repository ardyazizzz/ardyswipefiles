-- Swipe Ardy access hardening (LOCAL DRAFT; do not apply without review).
--
-- This migration intentionally preserves the public browse + extension capture
-- contract, while removing the pre-existing broad `ALL/public` policies that
-- make UPDATE/DELETE possible with an anonymous key. Apply only after the
-- extension's content-addressed upload path is deployed/verified.

-- Remove known legacy policies. `if exists` keeps this safe across slightly
-- different dashboard-created policy names.
drop policy if exists "Public access" on public.swipes;
drop policy if exists public_read on public.swipes;
drop policy if exists public_insert on public.swipes;
drop policy if exists auth_select on public.swipes;
drop policy if exists auth_insert on public.swipes;
drop policy if exists auth_update on public.swipes;
drop policy if exists auth_delete on public.swipes;

drop policy if exists anon_all on public.filter_configs;
drop policy if exists public_read on public.filter_configs;
drop policy if exists auth_all on public.filter_configs;

drop policy if exists anon_all on public.views_config;
drop policy if exists public_read on public.views_config;
drop policy if exists auth_all on public.views_config;

-- Revoke table privileges first: grants and RLS are separate controls.
revoke all on public.swipes from public, anon, authenticated;
revoke all on public.filter_configs from public, anon, authenticated;
revoke all on public.views_config from public, anon, authenticated;

grant select, insert on public.swipes to anon;
grant select, insert, update, delete on public.swipes to authenticated;
grant select on public.filter_configs to anon;
grant all on public.filter_configs to authenticated;
grant select on public.views_config to anon;
grant all on public.views_config to authenticated;

-- Service role is used only by the private agent Edge Function and admin
-- tooling. It bypasses RLS but still needs table privileges.
grant all on public.swipes to service_role;
grant all on public.filter_configs to service_role;
grant all on public.views_config to service_role;

create policy swipeardy_swipes_anon_read
  on public.swipes for select to anon using (true);
create policy swipeardy_swipes_anon_insert
  on public.swipes for insert to anon with check (true);
create policy swipeardy_swipes_auth_read
  on public.swipes for select to authenticated using (true);
create policy swipeardy_swipes_auth_insert
  on public.swipes for insert to authenticated with check (true);
create policy swipeardy_swipes_auth_update
  on public.swipes for update to authenticated using (true) with check (true);
create policy swipeardy_swipes_auth_delete
  on public.swipes for delete to authenticated using (true);

create policy swipeardy_filters_anon_read
  on public.filter_configs for select to anon using (true);
create policy swipeardy_filters_auth_all
  on public.filter_configs for all to authenticated using (true) with check (true);

create policy swipeardy_views_anon_read
  on public.views_config for select to anon using (true);
create policy swipeardy_views_auth_all
  on public.views_config for all to authenticated using (true) with check (true);

-- The old `swipe-assets` bucket is public by design so cards can render image
-- URLs directly. Keep public reads, but remove anonymous overwrite/update and
-- delete. Hash-addressed object names in the extension make retries safe with
-- insert-only access. This does not touch the unrelated `Images` bucket.
drop policy if exists "sa auth manage" on storage.objects;
drop policy if exists "sa anon upload" on storage.objects;
drop policy if exists "sa public read" on storage.objects;
drop policy if exists "sa anon update" on storage.objects;

create policy swipeardy_assets_public_read
  on storage.objects for select to public
  using (bucket_id = 'swipe-assets');
create policy swipeardy_assets_anon_insert
  on storage.objects for insert to anon
  with check (bucket_id = 'swipe-assets');
create policy swipeardy_assets_auth_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'swipe-assets');
create policy swipeardy_assets_auth_update
  on storage.objects for update to authenticated
  using (bucket_id = 'swipe-assets')
  with check (bucket_id = 'swipe-assets');
create policy swipeardy_assets_auth_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'swipe-assets');

comment on policy swipeardy_assets_anon_insert on storage.objects is
  'Anonymous extension capture may create new content-addressed objects; it cannot overwrite or delete existing media.';
