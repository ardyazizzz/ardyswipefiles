# Swipe Ardy Agent Gateway

This is the agent-facing interface for Swipe Ardy. It is separate from the
browser editor password and from the public Supabase publishable key.

## Endpoints (after deployment)

- MCP: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/mcp`
- REST: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/api/v1`
- OpenAPI: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/openapi.json`
- Health: `https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent/health`

The production database migrations and private Edge Function are active. Every
protected request still requires a separate hashed token for the calling agent.

## Capabilities

| MCP tool | Purpose | Safety behavior |
|---|---|---|
| `status` | Verify connection, region, scopes, and counts | Read-only |
| `search_posts` | Search any mode (`posts`, `creators`, `websites`, `snippets`) | Paginated, read-only |
| `get_post` | Read one structured record | Optional real image blocks |
| `get_post_image` | Fetch one image for vision/OCR | HTTPS-only, private-host block, 5 MB limit |
| `scan_image_health` | Probe explicit Posts-mode media | Read-only, max 25 posts and 8 media/post; reports healthy, broken, or uncheckable |
| `repair_post_images` | Archive browser-discovered replacement images and update one Post | Preview + human confirmation, 15-minute token, byte hash, immutable Storage paths, revision check |
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

## Public-browser image repair workflow

`scan_image_health` is intentionally bounded: pass specific Posts-mode IDs (up
to 25). It performs lightweight network checks on both image and video media.
A `broken` result is a definite 404/410. `uncheckable` is not proof that media
is gone; the source may reject lightweight requests or require a normal browser.
The repair tool itself remains image-only and will not replace a video field.

For a repair, Codex, Hermes, or another browser-capable agent performs the
browser step itself. The gateway does **not** control the browser, collect
cookies, store LinkedIn credentials, or bypass a sign-in wall.

1. Read the post and retain its `revision`; run `scan_image_health` if useful.
2. Open that post's `postUrl` in the agent's normal/in-app browser. Prefer a
   public page and extract the actual HTTPS image URL(s) from the post.
3. Call `repair_post_images` with `phase: "preview"`, the post ID, revision,
   fresh idempotency key, and up to four `source_image_urls`.
4. Review the returned source URLs and metadata with the user. The post remains
   untouched at this point.
5. Only after approval, call `repair_post_images` with `phase: "apply"`, the
   returned repair ID/token, same revision, and a **new** idempotency key.

On apply, the gateway refetches the source and verifies its SHA-256 hash still
matches the reviewed preview. It then copies the bytes to a new immutable path
in Swipe Ardy Storage and changes only the Post's comma-separated `image` field.
If the post revision or source bytes changed, it stops without updating the row.
It cannot recreate media that has been deleted from every public source.

## Codex setup

The checked-in `.codex/config.toml` is secret-free and reads
`SWIPEARDY_CODEX_TOKEN` from the environment. Set the token in your local shell;
never commit it.

## Hermes and other clients

`hermes.example.yaml` and `claude.example.json` are secret-free templates. On the
configured development machine, Hermes now has a `swipeardy` server entry alongside
the existing SwipeShare entry, using its own revocable token. Restart Hermes after
configuration changes so the server appears in its MCP list. Each client keeps its
own token and can be revoked independently; the endpoint and tool contract are
shared, not the credentials.

## Local secret files

Copy `.env.example` to `.env.local` only on your machine, and ensure that local
secret files remain excluded from version control. They must never be uploaded,
committed, or pasted into a chat.

## Read-only smoke test

Run the smoke test after a new client setup, gateway deployment, or restart. It
initializes MCP, verifies the expected tool surface, calls `status`, performs
one `search_posts` read, and runs one lightweight `scan_image_health` probe. It
never creates, updates, curates, repairs, or deletes data.

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-gateway\smoke-test.ps1
```

The script reads `SWIPEARDY_CODEX_TOKEN` from a local `.env.local` file or the
user environment and never prints its value.

