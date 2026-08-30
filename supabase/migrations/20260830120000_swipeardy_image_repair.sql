-- Swipe Ardy agent image health and repair (LOCAL/PRODUCTION MIGRATION).
--
-- This adds a private, short-lived repair preview ledger and one dedicated
-- public bucket for the immutable copies that have actually been approved.
-- It does not alter the original `swipes` rows or the existing extension.

create table if not exists public.swipeardy_agent_image_repairs (
  repair_id uuid primary key default gen_random_uuid(),
  agent_key_id uuid not null references public.swipeardy_agent_api_keys(id) on delete restrict,
  post_id bigint not null,
  expected_revision integer not null check (expected_revision > 0),
  source_post_url text,
  candidate_images jsonb not null default '[]'::jsonb,
  confirmation_hash text not null,
  status text not null default 'previewed'
    check (status in ('previewed', 'applied', 'expired', 'failed')),
  applied_object_paths jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists swipeardy_agent_image_repairs_agent_status_idx
  on public.swipeardy_agent_image_repairs (agent_key_id, status, expires_at desc);
create index if not exists swipeardy_agent_image_repairs_post_idx
  on public.swipeardy_agent_image_repairs (post_id, created_at desc);

alter table public.swipeardy_agent_image_repairs enable row level security;
revoke all on public.swipeardy_agent_image_repairs from public, anon, authenticated;
grant all on public.swipeardy_agent_image_repairs to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'swipeardy-repaired-media',
  'swipeardy-repaired-media',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists swipeardy_repaired_media_public_read on storage.objects;
create policy swipeardy_repaired_media_public_read
  on storage.objects for select to public
  using (bucket_id = 'swipeardy-repaired-media');

comment on table public.swipeardy_agent_image_repairs is
  'Private 15-minute preview ledger for revision-checked AI image repairs. Tokens are stored only as hashes.';
comment on policy swipeardy_repaired_media_public_read on storage.objects is
  'Approved replacement media only. Uploads are performed by the private service-role Edge Function with immutable object paths.';
