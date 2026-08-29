# Swipe Ardy Agent Gateway

This is the agent-facing interface for Swipe Ardy. It is separate from the
browser editor password and from the public Supabase publishable key.

## Endpoints (after deployment)

- MCP: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/mcp`
- REST: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/api/v1`
- OpenAPI: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/openapi.json`
- Health: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/health`

The endpoint is intentionally not usable until the database migrations are
reviewed/applied, a private Edge Function secret is configured, and a separate
hashed token is created for each agent.

## Capabilities

| MCP tool | Purpose | Safety behavior |
|---|---|---|
| `status` | Verify connection, region, scopes, and counts | Read-only |
| `search_posts` | Search any mode (`posts`, `creators`, `websites`, `snippets`) | Paginated, read-only |
| `get_post` | Read one structured record | Optional real image blocks |
| `get_post_image` | Fetch one image for vision/OCR | HTTPS-only, private-host block, 5 MB limit |
| `create_post` / `update_post` | Write Posts-mode records | Idempotency, dry-run, revision check |
| `delete_posts` | Delete Posts-mode records | Two-step confirmation, 30-day Trash |
| `list_trash` / `restore_post` | Review or recover deletion | Expiry and ID-conflict checks |
| `export_posts` | Export any mode | Private bucket, expiring signed URL |
| `curate_posts` | Batch curate Posts-mode records | Preview by default, max 100, atomic revision checks |
| `list_filters` / `update_filter_config` | Read or replace mode filters | Separate `filters` scope, idempotency, dry-run |
| `list_views` | Read saved views | Read-only |

Posts writes are deliberately the first write surface. Other modes are fully
readable now and can receive write aliases later without changing the database
contract.

## Safe agent workflow

1. Read `AGENTS.md`, this README, and `AGENT-COLLABORATION.md`.
2. Call `status`, then use narrow paginated `search_posts` calls.
3. Call `get_post` and include images only when visual analysis is needed.
4. Before editing, read and retain the latest `revision`.
5. Use a fresh idempotency key for each logical write and preview judgment-heavy
   changes with `dry_run: true`.
6. On a revision conflict, reread and reconsider; never force an overwrite.
7. Preview deletion first. Only a short-lived confirmation token can move rows
   to Trash, where they remain recoverable for 30 days.
8. Use `export_posts` for structured handoff; signed URLs expire after 15 minutes.

## Codex setup

The checked-in `.codex/config.toml` is secret-free and reads
`SWIPEARDY_CODEX_TOKEN` from the environment. Set the token in your local shell;
never commit it.

## Hermes and other clients

`hermes.example.yaml` and `claude.example.json` are templates only. Each client
must keep its own token and can be revoked independently. The endpoint and tool
contract are shared, not the credentials.

## Local secret files

Copy `.env.example` to `.env.local` only on your machine. `.env.local` is ignored
and must never be uploaded, committed, or pasted into a chat.
