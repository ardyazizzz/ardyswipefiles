-- Swipe Ardy recoverable deletion and atomic batch curation.
-- LOCAL DRAFT ONLY. These functions are deliberately callable by service_role
-- only; the public web app and extension continue using their existing paths.

create table if not exists public.swipeardy_agent_trash (
  trash_id uuid primary key default gen_random_uuid(),
  original_id bigint not null,
  original_mode text not null check (original_mode in ('posts', 'creators', 'websites', 'snippets')),
  original_revision bigint not null,
  item_data jsonb not null,
  deleted_by_agent_key_id uuid references public.swipeardy_agent_api_keys(id) on delete set null,
  deleted_by_agent_name text not null,
  deletion_request_id uuid not null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  restored_at timestamptz,
  restored_by_agent_name text
);

create table if not exists public.swipeardy_agent_delete_confirmations (
  confirmation_hash text primary key check (confirmation_hash ~ '^[0-9a-f]{64}$'),
  agent_key_id uuid not null references public.swipeardy_agent_api_keys(id) on delete cascade,
  mode text not null check (mode in ('posts', 'creators', 'websites', 'snippets')),
  item_ids bigint[] not null check (cardinality(item_ids) between 1 and 100),
  item_revisions jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at timestamptz
);

create index if not exists swipeardy_agent_trash_original_idx
  on public.swipeardy_agent_trash (original_id, deleted_at desc);
create index if not exists swipeardy_agent_trash_expiry_idx
  on public.swipeardy_agent_trash (expires_at);
create index if not exists swipeardy_agent_confirmations_agent_idx
  on public.swipeardy_agent_delete_confirmations (agent_key_id, created_at desc);

alter table public.swipeardy_agent_trash enable row level security;
alter table public.swipeardy_agent_delete_confirmations enable row level security;
revoke all on public.swipeardy_agent_trash from public, anon, authenticated;
revoke all on public.swipeardy_agent_delete_confirmations from public, anon, authenticated;
grant all on public.swipeardy_agent_trash to service_role;
grant all on public.swipeardy_agent_delete_confirmations to service_role;

create or replace function public.swipeardy_agent_delete_items(
  p_agent_key_id uuid,
  p_confirmation_hash text,
  p_request_id uuid,
  p_agent_name text,
  p_mode text
)
returns table(trash_id uuid, original_id bigint, original_mode text, original_revision bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  confirmation public.swipeardy_agent_delete_confirmations%rowtype;
  current_item public.swipes%rowtype;
  normalized_mode text := public.swipeardy_normalize_mode(p_mode);
  found_count integer;
begin
  select * into confirmation
  from public.swipeardy_agent_delete_confirmations
  where confirmation_hash = p_confirmation_hash
    and agent_key_id = p_agent_key_id
    and mode = normalized_mode
  for update;

  if not found then
    raise exception 'delete_confirmation_invalid' using errcode = 'P0001';
  end if;
  if confirmation.used_at is not null then
    raise exception 'delete_confirmation_used' using errcode = 'P0001';
  end if;
  if confirmation.expires_at <= now() then
    raise exception 'delete_confirmation_expired' using errcode = 'P0001';
  end if;

  select count(*) into found_count
  from public.swipes as s
  where s.id = any(confirmation.item_ids)
    and public.swipeardy_normalize_mode(s.type) = normalized_mode;
  if found_count <> cardinality(confirmation.item_ids) then
    raise exception 'delete_item_not_found' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.swipes as s
    where s.id = any(confirmation.item_ids)
      and public.swipeardy_normalize_mode(s.type) = normalized_mode
      and coalesce((confirmation.item_revisions ->> (s.id::text))::bigint, -1) <> s.revision
  ) then
    raise exception 'delete_revision_conflict' using errcode = 'P0001';
  end if;

  for current_item in
    select * from public.swipes as s
    where s.id = any(confirmation.item_ids)
      and public.swipeardy_normalize_mode(s.type) = normalized_mode
    order by s.id
    for update
  loop
    insert into public.swipeardy_agent_trash (
      original_id,
      original_mode,
      original_revision,
      item_data,
      deleted_by_agent_key_id,
      deleted_by_agent_name,
      deletion_request_id
    ) values (
      current_item.id,
      normalized_mode,
      current_item.revision,
      to_jsonb(current_item),
      p_agent_key_id,
      p_agent_name,
      p_request_id
    );
  end loop;

  delete from public.swipes as s
  where s.id = any(confirmation.item_ids)
    and public.swipeardy_normalize_mode(s.type) = normalized_mode;

  update public.swipeardy_agent_delete_confirmations
  set used_at = now()
  where confirmation_hash = p_confirmation_hash;

  return query
  select t.trash_id, t.original_id, t.original_mode, t.original_revision
  from public.swipeardy_agent_trash as t
  where t.deletion_request_id = p_request_id
  order by t.original_id;
end;
$$;

create or replace function public.swipeardy_agent_apply_curation(
  p_agent_key_id uuid,
  p_mode text,
  p_changes jsonb
)
returns setof public.swipes
language plpgsql
security invoker
set search_path = public
as $$
declare
  change jsonb;
  patch jsonb;
  current_item public.swipes%rowtype;
  updated_item public.swipes%rowtype;
  item_id bigint;
  expected_revision bigint;
  normalized_mode text := public.swipeardy_normalize_mode(p_mode);
begin
  if jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) < 1
     or jsonb_array_length(p_changes) > 100 then
    raise exception 'curation_batch_size_invalid' using errcode = 'P0001';
  end if;

  for change in select value from jsonb_array_elements(p_changes)
  loop
    item_id := (change ->> 'id')::bigint;
    expected_revision := (change ->> 'expected_revision')::bigint;
    patch := change -> 'patch';

    select * into current_item
    from public.swipes as s
    where s.id = item_id
      and public.swipeardy_normalize_mode(s.type) = normalized_mode
    for update;

    if not found then
      raise exception 'curation_item_not_found:%', item_id using errcode = 'P0001';
    end if;
    if current_item.revision <> expected_revision then
      raise exception 'curation_revision_conflict:%', item_id using errcode = 'P0001';
    end if;

    update public.swipes
    set
      author = case when patch ? 'author' then patch ->> 'author' else current_item.author end,
      date = case when patch ? 'date' then patch ->> 'date' else current_item.date end,
      platform = case when patch ? 'platform' then patch ->> 'platform' else current_item.platform end,
      filters = case when patch ? 'filters' then patch -> 'filters' else current_item.filters end,
      text = case when patch ? 'text' then patch ->> 'text' else current_item.text end,
      image = case when patch ? 'image' then patch ->> 'image' else current_item.image end,
      "postUrl" = case when patch ? 'postUrl' then nullif(patch ->> 'postUrl', '') else current_item."postUrl" end,
      reactions = case when patch ? 'reactions' then (patch ->> 'reactions')::bigint else current_item.reactions end,
      comments = case when patch ? 'comments' then (patch ->> 'comments')::bigint else current_item.comments end,
      reposts = case when patch ? 'reposts' then (patch ->> 'reposts')::bigint else current_item.reposts end,
      followers = case when patch ? 'followers' then (patch ->> 'followers')::bigint else current_item.followers end
    where id = item_id
    returning * into updated_item;

    return next updated_item;
  end loop;
end;
$$;

revoke all on function public.swipeardy_agent_delete_items(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.swipeardy_agent_delete_items(uuid, text, uuid, text, text)
  to service_role;
revoke all on function public.swipeardy_agent_apply_curation(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.swipeardy_agent_apply_curation(uuid, text, jsonb)
  to service_role;

comment on table public.swipeardy_agent_trash is
  'Recoverable snapshots of any Swipe Ardy mode deleted by an AI agent; retention is 30 days by default.';
comment on table public.swipeardy_agent_delete_confirmations is
  'Short-lived, hashed confirmation tokens for safe agent deletes.';
