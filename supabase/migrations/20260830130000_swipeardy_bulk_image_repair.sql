-- Bounded, resumable batch ledger for public-browser-discovered image repairs.
--
-- This table never stores browser credentials or plaintext confirmation tokens.
-- It is private to the service-role Agent Gateway. Each item remains independently
-- revision-checked when a reviewed batch is applied, so a stale record is skipped
-- instead of being overwritten.

create table if not exists public.swipeardy_agent_image_repair_batches (
  batch_id uuid primary key default gen_random_uuid(),
  agent_key_id uuid not null references public.swipeardy_agent_api_keys(id) on delete restrict,
  status text not null default 'previewed'
    check (status in ('previewed', 'applying', 'applied', 'partial', 'failed', 'expired')),
  item_count integer not null check (item_count between 1 and 25),
  items jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  confirmation_hash text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  applied_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists swipeardy_agent_image_repair_batches_agent_status_idx
  on public.swipeardy_agent_image_repair_batches (agent_key_id, status, expires_at desc);

alter table public.swipeardy_agent_image_repair_batches enable row level security;
revoke all on public.swipeardy_agent_image_repair_batches from public, anon, authenticated;
grant all on public.swipeardy_agent_image_repair_batches to service_role;

comment on table public.swipeardy_agent_image_repair_batches is
  'Private bounded batch-repair manifest. It stores reviewed public image candidates, per-item outcomes, and only a hash of the 15-minute confirmation token.';
