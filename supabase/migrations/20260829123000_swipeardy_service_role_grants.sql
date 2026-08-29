-- Internal gateway grants only (LOCAL/PRODUCTION MIGRATION).
-- This is intentionally separate from public access hardening: it gives the
-- private Edge Function's service_role the table privileges its RPCs need,
-- without changing anon/authenticated permissions or any rows.

grant all on public.swipes to service_role;
grant all on public.filter_configs to service_role;
grant all on public.views_config to service_role;
grant all on public.swipeardy_agent_api_keys to service_role;
grant all on public.swipeardy_agent_audit_log to service_role;
grant all on public.swipeardy_agent_idempotency_keys to service_role;
grant all on public.swipeardy_agent_trash to service_role;
grant all on public.swipeardy_agent_delete_confirmations to service_role;

grant execute on function public.swipeardy_normalize_mode(text) to service_role;
grant execute on function public.swipeardy_search_swipes(text, text, text, jsonb, integer, integer) to service_role;
grant execute on function public.swipeardy_get_swipe(bigint, text) to service_role;
grant execute on function public.swipeardy_agent_delete_items(uuid, text, uuid, text, text) to service_role;
grant execute on function public.swipeardy_agent_apply_curation(uuid, text, jsonb) to service_role;
