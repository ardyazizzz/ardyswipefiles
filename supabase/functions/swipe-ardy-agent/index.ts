import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { asObject, authenticateAgent, GatewayError, RequestContext } from "./core.ts";
import { executeTool, getPost, postToolResult, searchPosts, status, toolDefinitions, createPost, updatePost, deletePosts, listTrash, restorePost, exportPosts, curatePosts, listFilters, updateFilterConfig, listViews, scanImageHealth, repairPostImages } from "./gateway.ts";
import { openApiDocument } from "./openapi.ts";

const SERVER_NAME = "swipeardy";
const SERVER_VERSION = "1.1.0";
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"]);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (origin === "https://ardyazizzz.github.io") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(req: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, mcp-name, mcp-method, mcp-protocol-version, x-swipeardy-key",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
    "Access-Control-Expose-Headers": "mcp-protocol-version, request-id",
    "Vary": "Origin",
  });
  const origin = req.headers.get("origin");
  if (origin && isAllowedOrigin(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(req: Request, data: unknown, statusCode = 200, extra: HeadersInit = {}): Response {
  const headers = corsHeaders(req);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [key, value] of new Headers(extra)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status: statusCode, headers });
}

function emptyResponse(req: Request, statusCode: number, extra: HeadersInit = {}): Response {
  const headers = corsHeaders(req);
  for (const [key, value] of new Headers(extra)) headers.set(key, value);
  return new Response(null, { status: statusCode, headers });
}

function relativePath(url: URL): string {
  const marker = "/swipe-ardy-agent";
  const index = url.pathname.indexOf(marker);
  return index < 0 ? url.pathname || "/" : url.pathname.slice(index + marker.length) || "/";
}

async function readJson(req: Request): Promise<unknown> {
  let raw = "";
  try { raw = await req.text(); } catch { throw new GatewayError(400, "invalid_json", "Unable to read request body"); }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new GatewayError(400, "invalid_json", "Request body must be valid JSON"); }
}

function protocolFor(req: Request, body: Record<string, unknown>): string {
  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
  const requested = String(req.headers.get("mcp-protocol-version") || params.protocolVersion || DEFAULT_PROTOCOL);
  return SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
}

function withHeaderIdempotency(req: Request, body: unknown): Record<string, unknown> {
  const result = asObject(body, "body");
  const header = req.headers.get("idempotency-key");
  if (header && !result.idempotency_key) result.idempotency_key = header;
  return result;
}

function queryFilters(url: URL): unknown {
  const encoded = url.searchParams.get("filters");
  if (!encoded) return undefined;
  try { return JSON.parse(encoded); } catch { throw new GatewayError(400, "invalid_filters", "filters query parameter must be valid JSON"); }
}

function rpcSuccess(req: Request, id: unknown, result: unknown, protocol: string, modernDirect: boolean): Response {
  return jsonResponse(req, modernDirect ? result : { jsonrpc: "2.0", id: id ?? null, result }, 200, { "MCP-Protocol-Version": protocol });
}

function rpcError(req: Request, id: unknown, code: number, message: string, data: unknown, protocol: string): Response {
  return jsonResponse(req, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, 200, { "MCP-Protocol-Version": protocol });
}

async function handleMcp(req: Request, agent: Awaited<ReturnType<typeof authenticateAgent>>, requestId: string): Promise<Response> {
  if (req.method !== "POST") return emptyResponse(req, 405, { Allow: "POST" });
  const raw = await readJson(req);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rpcError(req, null, -32600, "Invalid Request", null, DEFAULT_PROTOCOL);
  const body = raw as Record<string, unknown>;
  const id = body.id;
  const modernMethod = req.headers.get("mcp-method");
  const method = String(body.method || modernMethod || "");
  const modernDirect = !body.jsonrpc && Boolean(modernMethod);
  const protocol = protocolFor(req, body);
  const ctx: RequestContext = { requestId, agent, transport: "mcp" };
  if (method === "notifications/initialized" || method === "initialized") return emptyResponse(req, 202, { "MCP-Protocol-Version": protocol });
  if (method === "initialize" || method === "server/discover") return rpcSuccess(req, id, { protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, title: "Swipe Ardy Agent Gateway", version: SERVER_VERSION }, instructions: "Use search_posts with mode=posts, creators, websites, or snippets. Use get_post(include_images=true) or get_post_image for direct multimodal analysis. scan_image_health is a bounded read-only probe for explicit Posts IDs. For repair_post_images, the agent itself opens the post in its browser, extracts public image URLs, previews them, obtains human approval, then applies with the short-lived confirmation token and the same revision. The gateway never controls a browser or uses browser credentials. Before editing a post, read its revision and pass expected_revision. Writes require a unique idempotency_key; dry_run previews without changing data. Deletion is two-step and recoverable: preview with delete_posts, then confirm with its short-lived token; deleted posts remain in 30-day Trash and can be restored. Use export_posts for private JSON/CSV/NDJSON/Markdown downloads." }, protocol, modernDirect);
  if (method === "ping") return rpcSuccess(req, id, {}, protocol, modernDirect);
  if (method === "tools/list") return rpcSuccess(req, id, { tools: toolDefinitions }, protocol, modernDirect);
  if (method === "tools/call") {
    const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
    const name = String(req.headers.get("mcp-name") || params.name || body.name || "");
    const args = params.arguments ?? body.arguments ?? (modernDirect ? body : {});
    try {
      return rpcSuccess(req, id, await executeTool(name, args, ctx), protocol, modernDirect);
    } catch (error) {
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(500, "internal_error", error instanceof Error ? error.message : "Unknown error");
      return rpcSuccess(req, id, { content: [{ type: "text", text: JSON.stringify({ error: { code: gatewayError.code, message: gatewayError.message, details: gatewayError.details }, request_id: requestId }) }], isError: true }, protocol, modernDirect);
    }
  }
  return rpcError(req, id, -32601, "Method not found", { method }, protocol);
}

async function handleRest(req: Request, path: string, url: URL, agent: Awaited<ReturnType<typeof authenticateAgent>>, requestId: string): Promise<Response> {
  const ctx: RequestContext = { requestId, agent, transport: "rest" };
  if (req.method === "GET" && path === "/api/v1/status") return jsonResponse(req, { request_id: requestId, data: await status(ctx) });
  if (req.method === "GET" && path === "/api/v1/posts") return jsonResponse(req, { request_id: requestId, data: await searchPosts(ctx, { mode: url.searchParams.get("mode") || "posts", query: url.searchParams.get("query") || undefined, platform: url.searchParams.get("platform") || undefined, filters: queryFilters(url), limit: url.searchParams.get("limit") || undefined, offset: url.searchParams.get("offset") || undefined }) });
  if (req.method === "POST" && path === "/api/v1/posts") return jsonResponse(req, { request_id: requestId, data: await createPost(ctx, withHeaderIdempotency(req, await readJson(req))) });
  if (req.method === "POST" && path === "/api/v1/posts/delete") return jsonResponse(req, { request_id: requestId, data: await deletePosts(ctx, withHeaderIdempotency(req, await readJson(req))) });
  if (req.method === "GET" && path === "/api/v1/trash") return jsonResponse(req, { request_id: requestId, data: await listTrash(ctx, { mode: url.searchParams.get("mode") || "posts", limit: url.searchParams.get("limit") || undefined }) });
  const trashMatch = path.match(/^\/api\/v1\/trash\/([^/]+)\/restore$/);
  if (trashMatch && req.method === "POST") return jsonResponse(req, { request_id: requestId, data: await restorePost(ctx, { ...withHeaderIdempotency(req, await readJson(req)), trash_id: trashMatch[1] }) });
  if (req.method === "POST" && path === "/api/v1/export") return jsonResponse(req, { request_id: requestId, data: await exportPosts(ctx, await readJson(req)) });
  if (req.method === "POST" && path === "/api/v1/curate") return jsonResponse(req, { request_id: requestId, data: await curatePosts(ctx, withHeaderIdempotency(req, await readJson(req))) });
  if (req.method === "POST" && path === "/api/v1/images/health") return jsonResponse(req, { request_id: requestId, data: await scanImageHealth(ctx, await readJson(req)) });
  if (req.method === "POST" && path === "/api/v1/images/repair") return jsonResponse(req, { request_id: requestId, data: await repairPostImages(ctx, withHeaderIdempotency(req, await readJson(req))) });
  const postMatch = path.match(/^\/api\/v1\/posts\/(\d+)$/);
  if (postMatch && req.method === "GET") {
    const record = await getPost(ctx, postMatch[1], url.searchParams.get("mode") || "posts");
    const includeImages = url.searchParams.get("include_images") === "true";
    return jsonResponse(req, { request_id: requestId, data: includeImages ? await postToolResult(ctx, record, true, Number(url.searchParams.get("max_images") || 2)) : record });
  }
  if (postMatch && req.method === "PATCH") return jsonResponse(req, { request_id: requestId, data: await updatePost(ctx, { ...withHeaderIdempotency(req, await readJson(req)), id: Number(postMatch[1]) }) });
  if (req.method === "GET" && path === "/api/v1/filters") return jsonResponse(req, { request_id: requestId, data: await listFilters(ctx, { mode: url.searchParams.get("mode") || "posts" }) });
  if (req.method === "PUT" && path === "/api/v1/filters") {
    const body = withHeaderIdempotency(req, await readJson(req));
    const mode = url.searchParams.get("mode");
    if (mode) body.mode = mode;
    return jsonResponse(req, { request_id: requestId, data: await updateFilterConfig(ctx, body) });
  }
  if (req.method === "GET" && path === "/api/v1/views") return jsonResponse(req, { request_id: requestId, data: await listViews(ctx) });
  throw new GatewayError(404, "route_not_found", `No route for ${req.method} ${path}`);
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  try {
    if (!isAllowedOrigin(req.headers.get("origin"))) throw new GatewayError(403, "origin_not_allowed", "Browser origin is not allowed");
    if (req.method === "OPTIONS") return emptyResponse(req, 204);
    const url = new URL(req.url);
    const path = relativePath(url);
    if (req.method === "GET" && (path === "/health" || path === "/")) return jsonResponse(req, { ok: true, service: "Swipe Ardy Agent Gateway", version: SERVER_VERSION, request_id: requestId });
    if (req.method === "GET" && path === "/openapi.json") return jsonResponse(req, openApiDocument);
    const agent = await authenticateAgent(req);
    if (path === "/mcp" || (path === "/" && req.method === "POST")) return await handleMcp(req, agent, requestId);
    return await handleRest(req, path, url, agent, requestId);
  } catch (error) {
    const gatewayError = error instanceof GatewayError ? error : new GatewayError(500, "internal_error", error instanceof Error ? error.message : "Unknown error");
    const headers: HeadersInit = { "Request-Id": requestId };
    if (gatewayError.status === 401) (headers as Record<string, string>)["WWW-Authenticate"] = 'Bearer realm="Swipe Ardy Agent Gateway"';
    return jsonResponse(req, { request_id: requestId, error: { code: gatewayError.code, message: gatewayError.message, details: gatewayError.details } }, gatewayError.status, headers);
  }
});
