-- Swipe Ardy Agent Gateway foundation.
--
-- This migration is intentionally additive. It does not rewrite legacy `type`
-- values: the application treats NULL/blank/unrecognised values as Posts, and
-- the gateway must preserve that behaviour through its mode normalizer.
-- Apply only after reviewing the accompanying access-hardening migration.

alter table public.swipes
  add column if not exists updated_at timestamptz,
  add column if not exists revision bigint,
  add column if not exists search_document tsvector;

update public.swipes
set
  updated_at = coalesce(updated_at, created_at, now()),
  revision = greatest(coalesce(revision, 1), 1),
  search_document = to_tsvector(
    'simple',
    concat_ws(
      ' ',
      coalesce(author, ''),
      coalesce(text, ''),
      coalesce(platform, ''),
      coalesce("postUrl", ''),
      coalesce(filters::text, '')
    )
  );

alter table public.swipes
  alter column updated_at set default now(),
  alter column updated_at set not null,
  alter column revision set default 1,
  alter column revision set not null;

create or replace function public.swipeardy_normalize_mode(raw_type text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case lower(coalesce(raw_type, ''))
    when 'creators' then 'creators'
    when 'websites' then 'websites'
    when 'snippets' then 'snippets'
    else 'posts'
  end;
$$;

create or replace function public.swipeardy_prepare_swipe_for_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.revision := coalesce(old.revision, 1) + 1;
  else
    new.updated_at := coalesce(new.updated_at, now());
    new.revision := greatest(coalesce(new.revision, 1), 1);
  end if;

  new.search_document := to_tsvector(
    'simple',
    concat_ws(
      ' ',
      coalesce(new.author, ''),
      coalesce(new.text, ''),
      coalesce(new.platform, ''),
      coalesce(new."postUrl", ''),
      coalesce(new.filters::text, '')
    )
  );
  return new;
end;
$$;

drop trigger if exists swipeardy_prepare_swipe_for_write on public.swipes;
create trigger swipeardy_prepare_swipe_for_write
before insert or update on public.swipes
for each row execute function public.swipeardy_prepare_swipe_for_write();

create index if not exists swipes_swipeardy_search_document_idx
  on public.swipes using gin (search_document);
create index if not exists swipes_swipeardy_filters_idx
  on public.swipes using gin (filters jsonb_path_ops);
create index if not exists swipes_swipeardy_mode_id_idx
  on public.swipes (
    (case lower(coalesce(type, ''))
      when 'creators' then 'creators'
      when 'websites' then 'websites'
      when 'snippets' then 'snippets'
      else 'posts'
    end),
    id desc
  );
create index if not exists swipes_swipeardy_platform_idx
  on public.swipes (platform);

-- Search uses the same mode normalisation as the web app. `p_mode='posts'`
-- therefore includes the 1,339 legacy rows with NULL/blank/unrecognised type.
create or replace function public.swipeardy_search_swipes(
  p_mode text default 'posts',
  p_query text default null,
  p_platform text default null,
  p_filters jsonb default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns setof public.swipes
language sql
stable
set search_path = public
as $$
  select s.*
  from public.swipes as s
  where public.swipeardy_normalize_mode(s.type) = public.swipeardy_normalize_mode(p_mode)
    and (
      p_query is null
      or btrim(p_query) = ''
      or s.search_document @@ websearch_to_tsquery('simple', p_query)
    )
    and (
      p_platform is null
      or btrim(p_platform) = ''
      or lower(coalesce(s.platform, '')) = lower(p_platform)
    )
    and (
      p_filters is null
      or p_filters = '{}'::jsonb
      or coalesce(s.filters, '{}'::jsonb) @> p_filters
    )
  order by s.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.swipeardy_get_swipe(
  p_id bigint,
  p_mode text default 'posts'
)
returns setof public.swipes
language sql
stable
set search_path = public
as $$
  select s.*
  from public.swipes as s
  where s.id = p_id
    and public.swipeardy_normalize_mode(s.type) = public.swipeardy_normalize_mode(p_mode)
  limit 1;
$$;

create table if not exists public.swipeardy_agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default array['read']::text[],
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  check (
    cardinality(scopes) > 0
    and scopes <@ array['read', 'write', 'filters', 'admin']::text[]
  )
);

create table if not exists public.swipeardy_agent_audit_log (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  agent_key_id uuid references public.swipeardy_agent_api_keys(id) on delete set null,
  agent_name text not null,
  action text not null,
  target text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.swipeardy_agent_idempotency_keys (
  agent_key_id uuid not null references public.swipeardy_agent_api_keys(id) on delete cascade,
  action text not null,
  idempotency_key text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (agent_key_id, action, idempotency_key),
  check (char_length(idempotency_key) between 8 and 200)
);

create index if not exists swipeardy_agent_audit_created_idx
  on public.swipeardy_agent_audit_log (created_at desc);
create index if not exists swipeardy_agent_audit_agent_idx
  on public.swipeardy_agent_audit_log (agent_key_id, created_at desc);
create index if not exists swipeardy_agent_idempotency_created_idx
  on public.swipeardy_agent_idempotency_keys (created_at desc);

alter table public.swipeardy_agent_api_keys enable row level security;
alter table public.swipeardy_agent_audit_log enable row level security;
alter table public.swipeardy_agent_idempotency_keys enable row level security;

revoke all on public.swipeardy_agent_api_keys from public, anon, authenticated;
revoke all on public.swipeardy_agent_audit_log from public, anon, authenticated;
revoke all on public.swipeardy_agent_idempotency_keys from public, anon, authenticated;
grant all on public.swipeardy_agent_api_keys to service_role;
grant all on public.swipeardy_agent_audit_log to service_role;
grant all on public.swipeardy_agent_idempotency_keys to service_role;

revoke all on function public.swipeardy_normalize_mode(text) from public, anon, authenticated;
revoke all on function public.swipeardy_search_swipes(text, text, text, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.swipeardy_get_swipe(bigint, text) from public, anon, authenticated;
grant execute on function public.swipeardy_normalize_mode(text) to service_role;
grant execute on function public.swipeardy_search_swipes(text, text, text, jsonb, integer, integer) to service_role;
grant execute on function public.swipeardy_get_swipe(bigint, text) to service_role;

insert into storage.buckets (id, name, public)
values ('swipeardy-agent-exports', 'swipeardy-agent-exports', false)
on conflict (id) do update set public = false;

comment on column public.swipes.revision is
  'Swipe Ardy optimistic concurrency version; incremented by swipeardy_prepare_swipe_for_write.';
comment on table public.swipeardy_agent_api_keys is
  'Hashed, revocable credentials for the Swipe Ardy Agent Gateway. Plaintext tokens are never stored.';
comment on table public.swipeardy_agent_audit_log is
  'Append-only audit trail for Swipe Ardy AI-agent previews and writes.';
