# Swipe Ardy cross-agent contract

This file keeps durable operating knowledge in the repository so Codex, Hermes,
Claude Code, and later MCP clients can work from the same contract.

## Source of truth

1. Swipe records, filters, and views remain in the original Swipe Ardy Supabase project.
2. `AGENTS.md` describes the browser app and extension coupling.
3. The gateway README and this contract describe the safe agent interface.
4. Git history is the source of truth for code and documentation changes.
5. Client-local environment files hold credentials only and are never shared.

## Identity and permissions

- Every agent uses its own revocable `swa_...` token and named key row.
- Tokens are scoped (`read`, `write`, `filters`, or `admin`) and hashed in Supabase.
- Never use the editor password, browser publishable key, or service-role key as an agent token.
- MCP is preferred. REST/OpenAPI is the fallback for clients without MCP support.

## Standard loop

- Start with `status`.
- Search narrowly with `search_posts`; pass `mode` explicitly when reading a non-Posts mode.
- Use `get_post(include_images=true)` or `get_post_image` for real pixel/OCR analysis.
- Keep the latest `revision` for any post update or curation decision.
- Preview writes and curation. Use a new idempotency key for the confirmed operation.
- Treat revision conflicts as a signal to reread, not as permission to overwrite.
- Preview deletes first; confirmation moves snapshots to 30-day Trash.
- Use `export_posts` for structured machine-readable handoff instead of scraping the UI.

## Knowledge handoff

Record durable discoveries in this repository or a normal Git commit. Do not rely
on one agent's chat memory. Keep commits small and explain intent so another
agent can inspect, test, revert, or extend the work.

Agents may tune their own prompts and tool selection. Credentials, token scopes,
and deployment ownership remain external controls and cannot be minted by a prompt.

## Client references

- Codex: `.codex/config.toml`
- Hermes: `agent-gateway/hermes.example.yaml`
- Claude Code: `agent-gateway/claude.example.json`
- Discovery: `agent-gateway/agent-manifest.json`
