import "jsr:@supabase/functions-js/edge-runtime.d.ts";

export type JsonObject = Record<string, unknown>;

export type AgentIdentity = {
  id: string;
  name: string;
  scopes: string[];
};

export type RequestContext = {
  requestId: string;
  agent: AgentIdentity;
  transport: "mcp" | "rest";
};

export class GatewayError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let cachedAdminKey: string | null = null;

function getAdminKey(): string {
  if (cachedAdminKey) return cachedAdminKey;
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, string>;
      cachedAdminKey = parsed.default || Object.values(parsed)[0] || null;
    } catch {
      throw new GatewayError(500, "server_misconfigured", "Invalid Supabase secret-key configuration");
    }
  }
  cachedAdminKey ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || null;
  if (!cachedAdminKey) throw new GatewayError(500, "server_misconfigured", "Supabase admin key is unavailable");
  return cachedAdminKey;
}

function getSupabaseUrl(): string {
  const value = Deno.env.get("SUPABASE_URL");
  if (!value) throw new GatewayError(500, "server_misconfigured", "SUPABASE_URL is unavailable");
  return value.replace(/\/$/, "");
}

export async function adminRequest(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ data: unknown; response: Response }> {
  const key = getAdminKey();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", key);
  headers.set("Accept", "application/json");
  if (!key.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${key}`);

  let body = init.body;
  if (Object.prototype.hasOwnProperty.call(init, "json")) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${getSupabaseUrl()}${path}`, { ...init, headers, body });
  const raw = await response.text();
  let data: unknown = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!response.ok) {
    const upstream = typeof data === "object" && data !== null ? data as JsonObject : {};
    throw new GatewayError(
      response.status >= 500 ? 502 : response.status,
      "supabase_request_failed",
      String(upstream.message || upstream.error || `Supabase returned HTTP ${response.status}`),
      { code: upstream.code, hint: upstream.hint, details: upstream.details },
    );
  }
  return { data, response };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

export async function authenticateAgent(req: Request): Promise<AgentIdentity> {
  const explicit = req.headers.get("x-swipeardy-key")?.trim();
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = explicit || bearer;
  if (!token || !/^swa_[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new GatewayError(401, "invalid_agent_token", "A valid Swipe Ardy agent token is required");
  }
  const keyHash = await sha256Hex(token);
  const query = new URLSearchParams({
    select: "id,name,scopes",
    key_hash: `eq.${keyHash}`,
    active: "eq.true",
    limit: "1",
  });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_api_keys?${query}`);
  const rows = Array.isArray(data) ? data as Array<JsonObject> : [];
  if (!rows[0]) throw new GatewayError(401, "invalid_agent_token", "Agent token is invalid or revoked");
  const agent: AgentIdentity = {
    id: String(rows[0].id),
    name: String(rows[0].name),
    scopes: Array.isArray(rows[0].scopes) ? rows[0].scopes.map(String) : [],
  };
  adminRequest(`/rest/v1/swipeardy_agent_api_keys?id=eq.${encodeURIComponent(agent.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    json: { last_used_at: new Date().toISOString() },
  }).catch(() => undefined);
  return agent;
}

export function requireScope(agent: AgentIdentity, scope: "read" | "write" | "filters"): void {
  if (agent.scopes.includes("admin") || agent.scopes.includes(scope)) return;
  throw new GatewayError(403, "insufficient_scope", `Agent token requires the '${scope}' scope`);
}

export async function writeAudit(
  ctx: RequestContext,
  action: string,
  target: string | null,
  beforeData: unknown,
  afterData: unknown,
  metadata: JsonObject = {},
): Promise<void> {
  await adminRequest("/rest/v1/swipeardy_agent_audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    json: {
      request_id: ctx.requestId,
      agent_key_id: ctx.agent.id,
      agent_name: ctx.agent.name,
      action,
      target,
      before_data: beforeData ?? null,
      after_data: afterData ?? null,
      metadata: { transport: ctx.transport, ...metadata },
    },
  });
}

export async function readIdempotentResult(
  ctx: RequestContext,
  action: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<{ requestHash: string; response: unknown | null }> {
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new GatewayError(400, "invalid_idempotency_key", "Idempotency key must contain 8 to 200 characters");
  }
  const requestHash = await sha256Hex(stableStringify(payload));
  const query = new URLSearchParams({
    select: "request_hash,response_data",
    agent_key_id: `eq.${ctx.agent.id}`,
    action: `eq.${action}`,
    idempotency_key: `eq.${idempotencyKey}`,
    limit: "1",
  });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_idempotency_keys?${query}`);
  const rows = Array.isArray(data) ? data as Array<JsonObject> : [];
  if (!rows[0]) return { requestHash, response: null };
  if (rows[0].request_hash !== requestHash) {
    throw new GatewayError(409, "idempotency_conflict", "This idempotency key was already used with a different request");
  }
  return { requestHash, response: rows[0].response_data ?? null };
}

export async function storeIdempotentResult(
  ctx: RequestContext,
  action: string,
  idempotencyKey: string,
  requestHash: string,
  responseData: unknown,
): Promise<void> {
  await adminRequest("/rest/v1/swipeardy_agent_idempotency_keys", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    json: {
      agent_key_id: ctx.agent.id,
      action,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      response_data: responseData,
    },
  });
}

export function asObject(value: unknown, label = "value"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_input", `${label} must be a JSON object`);
  }
  return value as JsonObject;
}

export function asArray(value: unknown, label = "value"): unknown[] {
  if (!Array.isArray(value)) throw new GatewayError(400, "invalid_input", `${label} must be an array`);
  return value;
}

export function cleanText(value: unknown, label: string, maxLength: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new GatewayError(400, "invalid_input", `${label} is required`);
    return null;
  }
  if (typeof value !== "string") throw new GatewayError(400, "invalid_input", `${label} must be a string`);
  const result = value.trim();
  if (required && !result) throw new GatewayError(400, "invalid_input", `${label} is required`);
  if (result.length > maxLength) throw new GatewayError(400, "invalid_input", `${label} exceeds ${maxLength} characters`);
  return result;
}

export function cleanInteger(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null || value === "") return fallback;
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new GatewayError(400, "invalid_input", `${label} must be a non-negative safe integer`);
  }
  return result;
}

export function normalizeMode(value: unknown, fallback = "posts"): "posts" | "creators" | "websites" | "snippets" {
  const mode = String(value || fallback).toLowerCase();
  if (!["posts", "creators", "websites", "snippets"].includes(mode)) {
    throw new GatewayError(400, "invalid_mode", "mode must be posts, creators, websites, or snippets");
  }
  return mode as "posts" | "creators" | "websites" | "snippets";
}

export function requireIdempotency(input: JsonObject): string {
  const value = cleanText(input.idempotency_key, "idempotency_key", 200, true);
  if (!value || value.length < 8) throw new GatewayError(400, "invalid_idempotency_key", "idempotency_key must contain at least 8 characters");
  return value;
}

export function isDryRun(input: JsonObject, defaultValue = false): boolean {
  return input.dry_run === undefined ? defaultValue : input.dry_run === true;
}
