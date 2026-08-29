-- Read-only exact counts for the agent gateway status endpoint.
-- This avoids counting the deliberately limited search RPC result.

create or replace function public.swipeardy_count_swipes(
  p_mode text default 'posts'
)
returns bigint
language sql
stable
set search_path = public
as $$
  select count(*)
  from public.swipes as s
  where public.swipeardy_normalize_mode(s.type) = public.swipeardy_normalize_mode(p_mode);
$$;

revoke all on function public.swipeardy_count_swipes(text) from public, anon, authenticated;
grant execute on function public.swipeardy_count_swipes(text) to service_role;

