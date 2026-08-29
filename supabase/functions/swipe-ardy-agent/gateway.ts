import {
  adminRequest,
  asArray,
  asObject,
  cleanInteger,
  cleanText,
  GatewayError,
  isDryRun,
  normalizeMode,
  readIdempotentResult,
  requireIdempotency,
  requireScope,
  RequestContext,
  sha256Hex,
  storeIdempotentResult,
  writeAudit,
  JsonObject,
} from "./core.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type SwipeRow = JsonObject & {
  id: number;
  type?: string | null;
  revision?: number;
};

const MAX_SEARCH_LIMIT = 200;
const MAX_IMAGES_PER_CALL = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_PATCH_FIELDS = new Set([
  "author", "date", "platform", "filters", "text", "image", "postUrl",
  "reactions", "comments", "reposts", "followers",
]);

const postFields = {
  author: { type: "string" },
  date: { type: "string" },
  platform: { type: "string" },
  filters: { type: "object", additionalProperties: true },
  text: { type: "string" },
  image: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: 20 }] },
  postUrl: { type: "string" },
  reactions: { type: "integer", minimum: 0 },
  comments: { type: "integer", minimum: 0 },
  reposts: { type: "integer", minimum: 0 },
  followers: { type: "integer", minimum: 0 },
};

const modeProperty = { type: "string", enum: ["posts", "creators", "websites", "snippets"], default: "posts" };

export const toolDefinitions = [
  {
    name: "status",
    description: "Check the Swipe Ardy Agent Gateway, token scopes, region, and row counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Swipe Ardy status", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "search_posts",
    description: "Search Swipe Ardy records. Use mode=posts for normal posts; mode=creators, websites, or snippets reads those modes too. Legacy rows without a type are Posts.",
    inputSchema: {
      type: "object",
      properties: {
        mode: modeProperty,
        query: { type: "string" },
        platform: { type: "string" },
        filters: { type: "object", additionalProperties: true },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    annotations: { title: "Search Swipe Ardy records", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_post",
    description: "Read one structured Swipe Ardy record. Set include_images=true when the agent needs to see the actual pixels.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 }, mode: modeProperty, include_images: { type: "boolean", default: false }, max_images: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, default: 2 } }, additionalProperties: false },
    annotations: { title: "Read a Swipe Ardy record", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "get_post_image",
    description: "Fetch a record image as an MCP image content block for vision/OCR analysis.",
    inputSchema: { type: "object", required: ["post_id"], properties: { post_id: { type: "integer", minimum: 1 }, mode: modeProperty, image_index: { type: "integer", minimum: 0, default: 0 } }, additionalProperties: false },
    annotations: { title: "Inspect a Swipe Ardy image", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "create_post",
    description: "Create a Posts-mode item. Writes require an idempotency_key; dry_run previews without changing data.",
    inputSchema: { type: "object", required: ["post", "idempotency_key"], properties: { post: { type: "object", properties: postFields, additionalProperties: false }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 }, dry_run: { type: "boolean", default: false } }, additionalProperties: false },
    annotations: { title: "Create a Swipe Ardy post", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "update_post",
    description: "Update selected Posts-mode fields. Read the latest revision first; stale writes are rejected.",
    inputSchema: { type: "object", required: ["id", "expected_revision", "patch", "idempotency_key"], properties: { id: { type: "integer", minimum: 1 }, expected_revision: { type: "integer", minimum: 1 }, patch: { type: "object", properties: postFields, minProperties: 1, additionalProperties: false }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 }, dry_run: { type: "boolean", default: false } }, additionalProperties: false },
    annotations: { title: "Update a Swipe Ardy post", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "delete_posts",
    description: "Two-step recoverable delete for Posts-mode records. First preview (dry_run=true), then confirm with the returned token. Trash retention is 30 days.",
    inputSchema: { type: "object", required: ["ids", "idempotency_key"], properties: { ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 100 }, confirmation_token: { type: "string", minLength: 20, maxLength: 200 }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 }, dry_run: { type: "boolean", default: true } }, additionalProperties: false },
    annotations: { title: "Delete Swipe Ardy posts", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "list_trash",
    description: "List recoverable AI-agent deletions from the 30-day Trash.",
    inputSchema: { type: "object", properties: { mode: modeProperty, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, additionalProperties: false },
    annotations: { title: "List Swipe Ardy Trash", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "restore_post",
    description: "Restore one Trash item to its original ID, unless that ID is now occupied.",
    inputSchema: { type: "object", required: ["trash_id", "idempotency_key"], properties: { trash_id: { type: "string", format: "uuid" }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, additionalProperties: false },
    annotations: { title: "Restore a Swipe Ardy item", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "export_posts",
    description: "Create a private, expiring structured export of any Swipe Ardy mode: JSON, CSV, NDJSON, or Markdown.",
    inputSchema: { type: "object", properties: { mode: modeProperty, ids: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 1000 }, query: { type: "string" }, platform: { type: "string" }, filters: { type: "object", additionalProperties: true }, format: { type: "string", enum: ["json", "csv", "ndjson", "markdown"], default: "json" }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 200 } }, additionalProperties: false },
    annotations: { title: "Export Swipe Ardy data", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "curate_posts",
    description: "Preview or atomically apply up to 100 Posts-mode patches. Every item needs its expected revision; previews are the default.",
    inputSchema: { type: "object", required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["id", "expected_revision", "patch"], properties: { id: { type: "integer" }, expected_revision: { type: "integer" }, patch: { type: "object" } }, additionalProperties: false } }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 }, dry_run: { type: "boolean", default: true } }, additionalProperties: false },
    annotations: { title: "Curate Swipe Ardy posts", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_filters",
    description: "Read filter definitions and colors for any Swipe Ardy mode.",
    inputSchema: { type: "object", properties: { mode: modeProperty }, additionalProperties: false },
    annotations: { title: "Read Swipe Ardy filters", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "update_filter_config",
    description: "Replace one mode's filter definitions and colors. Requires the filters scope, idempotency, and supports dry_run.",
    inputSchema: { type: "object", required: ["filters", "colors", "idempotency_key"], properties: { mode: modeProperty, filters: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } }, colors: { type: "object", additionalProperties: true }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 }, dry_run: { type: "boolean", default: false } }, additionalProperties: false },
    annotations: { title: "Update Swipe Ardy filters", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_views",
    description: "Read saved Swipe Ardy views and presets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Read Swipe Ardy views", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
] as const;

function stripInternal(row: unknown): SwipeRow {
  const value = asObject(row, "record") as SwipeRow;
  const safe = { ...value };
  delete safe.search_document;
  return safe;
}

function normalizedRawMode(rawType: unknown): string {
  const value = String(rawType || "").toLowerCase();
  return ["creators", "websites", "snippets"].includes(value) ? value : "posts";
}

function imageList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function imageString(value: unknown): string {
  return imageList(value).join(",");
}

function createPayload(value: unknown): JsonObject {
  const input = asObject(value, "post");
  const filters = input.filters === undefined ? {} : asObject(input.filters, "post.filters");
  const payload: JsonObject = {
    type: "posts",
    author: cleanText(input.author, "post.author", 1000, true),
    date: cleanText(input.date, "post.date", 200, false),
    platform: cleanText(input.platform, "post.platform", 200, false),
    filters,
    text: cleanText(input.text, "post.text", 50000, false),
    image: imageString(input.image),
    postUrl: cleanText(input.postUrl, "post.postUrl", 4000, false),
    reactions: cleanInteger(input.reactions, "post.reactions", 0),
    comments: cleanInteger(input.comments, "post.comments", 0),
    reposts: cleanInteger(input.reposts, "post.reposts", 0),
    followers: input.followers == null ? null : cleanInteger(input.followers, "post.followers", 0),
  };
  if (!String(payload.text || "").trim() && !String(payload.image || "").trim() && !String(payload.postUrl || "").trim()) {
    throw new GatewayError(400, "invalid_input", "post must contain text, image, or postUrl");
  }
  return payload;
}

function patchPayload(value: unknown): JsonObject {
  const input = asObject(value, "patch");
  const output: JsonObject = {};
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PATCH_FIELDS.has(key)) throw new GatewayError(400, "invalid_input", `patch field '${key}' is not writable`);
    if (key === "filters") output[key] = asObject(input[key], "patch.filters");
    else if (key === "image") output[key] = imageString(input[key]);
    else if (["reactions", "comments", "reposts", "followers"].includes(key)) output[key] = input[key] == null ? null : cleanInteger(input[key], `patch.${key}`, 0);
    else output[key] = cleanText(input[key], `patch.${key}`, key === "text" ? 50000 : 4000, false);
  }
  return output;
}

function normalizeIds(value: unknown, max: number): number[] {
  const values = asArray(value, "ids");
  if (values.length < 1 || values.length > max) throw new GatewayError(400, "invalid_input", `ids must contain between 1 and ${max} values`);
  const ids = [...new Set(values.map((v, i) => cleanInteger(v, `ids[${i}]`)))];
  if (ids.some((id) => id < 1)) throw new GatewayError(400, "invalid_input", "ids must be positive integers");
  return ids;
}

export async function getPost(ctx: RequestContext, idValue: unknown, modeValue: unknown = "posts"): Promise<SwipeRow> {
  requireScope(ctx.agent, "read");
  const id = cleanInteger(idValue, "id");
  const mode = normalizeMode(modeValue);
  const { data } = await adminRequest("/rest/v1/rpc/swipeardy_get_swipe", { method: "POST", json: { p_id: id, p_mode: mode } });
  const rows = Array.isArray(data) ? data : [];
  if (!rows[0]) throw new GatewayError(404, "record_not_found", `${mode} record ${id} was not found`);
  return stripInternal(rows[0]);
}

export async function searchPosts(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  const input = asObject(args || {}, "arguments");
  const mode = normalizeMode(input.mode);
  const limit = Math.min(Math.max(cleanInteger(input.limit, "limit", 50), 1), MAX_SEARCH_LIMIT);
  const offset = cleanInteger(input.offset, "offset", 0);
  const query = cleanText(input.query, "query", 1000, false);
  const platform = cleanText(input.platform, "platform", 200, false);
  const filters = input.filters === undefined || input.filters === null ? null : asObject(input.filters, "filters");
  const { data } = await adminRequest("/rest/v1/rpc/swipeardy_search_swipes", { method: "POST", json: { p_mode: mode, p_query: query, p_platform: platform, p_filters: filters, p_limit: limit, p_offset: offset } });
  const rows = Array.isArray(data) ? data.map(stripInternal) : [];
  return { mode, query: query || null, platform: platform || null, limit, offset, count: rows.length, records: rows };
}

async function existingId(): Promise<number> {
  let id = Date.now();
  for (let attempt = 0; attempt < 5; attempt++, id++) {
    const query = new URLSearchParams({ select: "id", id: `eq.${id}`, limit: "1" });
    const { data } = await adminRequest(`/rest/v1/swipes?${query}`);
    if (!Array.isArray(data) || data.length === 0) return id;
  }
  throw new GatewayError(409, "id_generation_conflict", "Could not allocate a unique record ID");
}

export async function createPost(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const key = requireIdempotency(input);
  const payload = createPayload(input.post);
  const replay = await readIdempotentResult(ctx, "posts.create", key, { payload });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  if (isDryRun(input)) {
    const preview = { dry_run: true, post: { ...payload, id: await existingId() } };
    await writeAudit(ctx, "posts.create.preview", null, null, preview);
    return preview;
  }
  const id = await existingId();
  payload.id = id;
  const { data } = await adminRequest("/rest/v1/swipes?select=*", { method: "POST", headers: { Prefer: "return=representation" }, json: payload });
  const record = Array.isArray(data) && data[0] ? stripInternal(data[0]) : { ...payload, id };
  const result = { dry_run: false, record, idempotent_replay: false };
  await writeAudit(ctx, "posts.create", String(id), null, record);
  await storeIdempotentResult(ctx, "posts.create", key, replay.requestHash, result);
  return result;
}

export async function updatePost(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const id = cleanInteger(input.id, "id");
  const expectedRevision = cleanInteger(input.expected_revision, "expected_revision");
  if (expectedRevision < 1) throw new GatewayError(400, "invalid_input", "expected_revision must be positive");
  const patch = patchPayload(input.patch);
  const inputKey = requireIdempotency(input);
  const replay = await readIdempotentResult(ctx, "posts.update", inputKey, { id, expected_revision: expectedRevision, patch });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const current = await getPost(ctx, id, "posts");
  if (Number(current.revision) !== expectedRevision) throw new GatewayError(409, "revision_conflict", `Post ${id} changed since it was read`, { id, expected_revision: expectedRevision, current_revision: current.revision });
  const candidate = { ...current, ...patch };
  if (!String(candidate.author || "").trim()) throw new GatewayError(400, "invalid_input", "Post author cannot be empty");
  if (!String(candidate.text || "").trim() && !String(candidate.image || "").trim() && !String(candidate.postUrl || "").trim()) throw new GatewayError(400, "invalid_input", "Post must retain text, image, or postUrl");
  if (isDryRun(input)) {
    const preview = { dry_run: true, id, expected_revision: expectedRevision, before: current, would_update: candidate };
    await writeAudit(ctx, "posts.update.preview", String(id), current, preview);
    return preview;
  }
  // IDs are globally unique in `swipes`; the mode was checked by getPost.
  // Filtering only by id + revision also covers legacy NULL, blank, and
  // unrecognised `type` values that the web app treats as Posts.
  const query = new URLSearchParams({ id: `eq.${id}`, revision: `eq.${expectedRevision}` });
  const response = await adminRequest(`/rest/v1/swipes?${query}`, { method: "PATCH", headers: { Prefer: "return=representation" }, json: patch });
  const updatedRows = Array.isArray(response.data) ? response.data : [];
  if (!updatedRows.length) {
    const latest = await getPost(ctx, id, "posts");
    throw new GatewayError(409, "revision_conflict", `Post ${id} changed while the update was being applied`, { expected_revision: expectedRevision, current_revision: latest.revision });
  }
  const updated = stripInternal(updatedRows[0]);
  const result = { dry_run: false, record: updated, idempotent_replay: false };
  await writeAudit(ctx, "posts.update", String(id), current, updated);
  await storeIdempotentResult(ctx, "posts.update", inputKey, replay.requestHash, result);
  return result;
}

async function createDeletePreview(ctx: RequestContext, ids: number[]): Promise<JsonObject> {
  const items: SwipeRow[] = [];
  for (const id of ids) items.push(await getPost(ctx, id, "posts"));
  const plainToken = `swdc_${crypto.randomUUID()}_${crypto.randomUUID()}`;
  const confirmationHash = await sha256Hex(plainToken);
  const revisions: JsonObject = {};
  for (const item of items) revisions[String(item.id)] = item.revision;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await adminRequest("/rest/v1/swipeardy_agent_delete_confirmations", { method: "POST", headers: { Prefer: "return=minimal" }, json: { confirmation_hash: confirmationHash, agent_key_id: ctx.agent.id, mode: "posts", item_ids: ids, item_revisions: revisions, expires_at: expiresAt } });
  return { dry_run: true, mode: "posts", count: items.length, items, confirmation_token: plainToken, confirmation_expires_at: expiresAt, idempotent_replay: false };
}

export async function deletePosts(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const ids = normalizeIds(input.ids, 100);
  const key = requireIdempotency(input);
  const isConfirmation = typeof input.confirmation_token === "string" && input.confirmation_token.trim().length > 0;
  const action = isConfirmation ? "posts.delete" : "posts.delete.preview";
  const replay = await readIdempotentResult(ctx, action, key, { ids, confirmation_token: isConfirmation ? input.confirmation_token : null });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  if (!isConfirmation || isDryRun(input, true)) {
    const preview = await createDeletePreview(ctx, ids);
    await writeAudit(ctx, "posts.delete.preview", ids.join(","), null, preview, { count: ids.length });
    await storeIdempotentResult(ctx, "posts.delete.preview", key, replay.requestHash, preview);
    return preview;
  }
  const confirmationHash = await sha256Hex(String(input.confirmation_token));
  const { data } = await adminRequest("/rest/v1/rpc/swipeardy_agent_delete_items", { method: "POST", json: { p_agent_key_id: ctx.agent.id, p_confirmation_hash: confirmationHash, p_request_id: ctx.requestId, p_agent_name: ctx.agent.name, p_mode: "posts" } });
  const deleted = Array.isArray(data) ? data : [];
  const result = { dry_run: false, mode: "posts", count: deleted.length, deleted, idempotent_replay: false };
  await writeAudit(ctx, "posts.delete", ids.join(","), null, result, { count: deleted.length });
  await storeIdempotentResult(ctx, "posts.delete", key, replay.requestHash, result);
  return result;
}

export async function listTrash(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  const input = asObject(args || {}, "arguments");
  const mode = normalizeMode(input.mode);
  const limit = Math.min(Math.max(cleanInteger(input.limit, "limit", 50), 1), 100);
  const query = new URLSearchParams({ select: "trash_id,original_id,original_mode,original_revision,item_data,deleted_by_agent_name,deletion_request_id,deleted_at,expires_at,restored_at", original_mode: `eq.${mode}`, restored_at: "is.null", expires_at: `gt.${new Date().toISOString()}`, order: "deleted_at.desc", limit: String(limit) });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_trash?${query}`);
  return { mode, count: Array.isArray(data) ? data.length : 0, items: Array.isArray(data) ? data : [] };
}

function restorePayload(itemData: unknown, id: number, revision: number): JsonObject {
  const item = asObject(itemData, "trash.item_data");
  const payload: JsonObject = { ...item, id, revision };
  delete payload.search_document;
  delete payload.updated_at;
  delete payload.created_at;
  return payload;
}

export async function restorePost(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const trashId = cleanText(input.trash_id, "trash_id", 100, true)!;
  const key = requireIdempotency(input);
  const replay = await readIdempotentResult(ctx, "trash.restore", key, { trash_id: trashId });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const query = new URLSearchParams({ select: "*", trash_id: `eq.${trashId}`, restored_at: "is.null", limit: "1" });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_trash?${query}`);
  const rows = Array.isArray(data) ? data as Array<JsonObject> : [];
  if (!rows[0]) throw new GatewayError(404, "trash_not_found", "Trash item was not found or was already restored");
  const trash = rows[0];
  if (new Date(String(trash.expires_at)).getTime() <= Date.now()) throw new GatewayError(410, "trash_expired", "Trash item has expired");
  const id = cleanInteger(trash.original_id, "trash.original_id");
  const existingQuery = new URLSearchParams({ select: "id", id: `eq.${id}`, limit: "1" });
  const existing = await adminRequest(`/rest/v1/swipes?${existingQuery}`);
  if (Array.isArray(existing.data) && existing.data.length) throw new GatewayError(409, "restore_id_conflict", `Original ID ${id} is already used`);
  const payload = restorePayload(trash.item_data, id, cleanInteger(trash.original_revision, "trash.original_revision") + 1);
  const inserted = await adminRequest("/rest/v1/swipes?select=*", { method: "POST", headers: { Prefer: "return=representation" }, json: payload });
  const record = Array.isArray(inserted.data) && inserted.data[0] ? stripInternal(inserted.data[0]) : payload;
  await adminRequest(`/rest/v1/swipeardy_agent_trash?trash_id=eq.${encodeURIComponent(trashId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { restored_at: new Date().toISOString(), restored_by_agent_name: ctx.agent.name } });
  const result = { dry_run: false, record, idempotent_replay: false };
  await writeAudit(ctx, "trash.restore", trashId, trash, record);
  await storeIdempotentResult(ctx, "trash.restore", key, replay.requestHash, result);
  return result;
}

const exportColumns = ["id", "type", "author", "date", "platform", "filters", "text", "image", "postUrl", "reactions", "comments", "reposts", "followers", "created_at", "updated_at", "revision"];

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatExport(records: SwipeRow[], format: string): { content: string; mimeType: string; extension: string } {
  if (format === "csv") return { content: [exportColumns.join(","), ...records.map((r) => exportColumns.map((c) => csvCell(r[c])).join(","))].join("\r\n"), mimeType: "text/csv; charset=utf-8", extension: "csv" };
  if (format === "ndjson") return { content: records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), mimeType: "application/x-ndjson; charset=utf-8", extension: "ndjson" };
  if (format === "markdown") return { content: records.map((r) => [`## ${r.author || "Untitled"} (#${r.id})`, r.postUrl ? `Source: ${r.postUrl}` : "", r.platform ? `Platform: ${r.platform}` : "", "", String(r.text || ""), "", `Revision: ${r.revision}`].filter(Boolean).join("\n")).join("\n\n---\n\n"), mimeType: "text/markdown; charset=utf-8", extension: "md" };
  return { content: JSON.stringify(records, null, 2), mimeType: "application/json; charset=utf-8", extension: "json" };
}

async function uploadPrivateExport(ctx: RequestContext, content: string, mimeType: string, extension: string): Promise<JsonObject> {
  const path = `exports/${ctx.agent.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  await adminRequest(`/storage/v1/object/swipeardy-agent-exports/${encodedPath}`, { method: "POST", headers: { "Content-Type": mimeType, "x-upsert": "true" }, body: content });
  const signed = await adminRequest(`/storage/v1/object/sign/swipeardy-agent-exports/${encodedPath}`, { method: "POST", headers: { "Content-Type": "application/json" }, json: { expiresIn: 900 } });
  const signedData = asObject(signed.data, "signed export response");
  const signedPath = String(signedData.signedURL || signedData.signedUrl || "");
  if (!signedPath) throw new GatewayError(502, "export_sign_failed", "Supabase did not return a signed download URL");
  const base = (Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const downloadUrl = signedPath.startsWith("http") ? signedPath : signedPath.startsWith("/storage/") ? `${base}${signedPath}` : signedPath.startsWith("/object/") ? `${base}/storage/v1${signedPath}` : `${base}/storage/v1/${signedPath.replace(/^\/+/, "")}`;
  return { path, download_url: downloadUrl, download_url_expires_at: new Date(Date.now() + 900000).toISOString() };
}

async function recordsByIds(ids: number[], mode: string): Promise<SwipeRow[]> {
  const query = new URLSearchParams({ select: "*", id: `in.(${ids.join(",")})`, limit: String(Math.min(ids.length, 1000)) });
  const { data } = await adminRequest(`/rest/v1/swipes?${query}`);
  return (Array.isArray(data) ? data : []).filter((r) => normalizedRawMode((r as JsonObject).type) === mode).map(stripInternal);
}

export async function exportPosts(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  const input = asObject(args || {}, "arguments");
  const mode = normalizeMode(input.mode);
  const format = cleanText(input.format, "format", 20) || "json";
  if (!["json", "csv", "ndjson", "markdown"].includes(format)) throw new GatewayError(400, "invalid_input", "format must be json, csv, ndjson, or markdown");
  const limit = Math.min(Math.max(cleanInteger(input.limit, "limit", 200), 1), 1000);
  let records: SwipeRow[] = [];
  if (input.ids !== undefined) records = (await recordsByIds(normalizeIds(input.ids, 1000), mode)).slice(0, limit);
  else {
    let offset = 0;
    while (records.length < limit) {
      const pageSize = Math.min(MAX_SEARCH_LIMIT, limit - records.length);
      const page = await searchPosts(ctx, { mode, query: input.query, platform: input.platform, filters: input.filters, limit: pageSize, offset });
      const pageRecords = Array.isArray(page.records) ? page.records as SwipeRow[] : [];
      records.push(...pageRecords);
      if (pageRecords.length < pageSize) break;
      offset += pageRecords.length;
    }
  }
  const rendered = formatExport(records.slice(0, limit), format);
  const uploaded = await uploadPrivateExport(ctx, rendered.content, rendered.mimeType, rendered.extension);
  const result = { mode, format, count: records.length, columns: exportColumns, ...uploaded };
  await writeAudit(ctx, "records.export", null, null, { mode, format, count: records.length });
  return result;
}

export async function curatePosts(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const items = asArray(input.items, "items");
  if (items.length < 1 || items.length > 100) throw new GatewayError(400, "invalid_input", "items must contain between 1 and 100 curation changes");
  const changes: JsonObject[] = [];
  const previews: JsonObject[] = [];
  const before: SwipeRow[] = [];
  for (const [index, raw] of items.entries()) {
    const item = asObject(raw, `items[${index}]`);
    const id = cleanInteger(item.id, `items[${index}].id`);
    const expectedRevision = cleanInteger(item.expected_revision, `items[${index}].expected_revision`);
    const patch = patchPayload(item.patch);
    const current = await getPost(ctx, id, "posts");
    if (Number(current.revision) !== expectedRevision) throw new GatewayError(409, "revision_conflict", `Post ${id} changed since it was read`, { id, expected_revision: expectedRevision, current_revision: current.revision });
    const candidate = { ...current, ...patch };
    if (!String(candidate.author || "").trim()) throw new GatewayError(400, "invalid_input", `Post ${id} author cannot be empty`);
    if (!String(candidate.text || "").trim() && !String(candidate.image || "").trim() && !String(candidate.postUrl || "").trim()) throw new GatewayError(400, "invalid_input", `Post ${id} would have no content`);
    before.push(current);
    changes.push({ id, expected_revision: expectedRevision, patch });
    previews.push({ id, expected_revision: expectedRevision, before: current, would_update: candidate });
  }
  if (isDryRun(input, true)) {
    const preview = { dry_run: true, mode: "posts", count: previews.length, items: previews };
    await writeAudit(ctx, "posts.curate.preview", null, before, preview, { count: previews.length });
    return preview;
  }
  const key = requireIdempotency(input);
  const replay = await readIdempotentResult(ctx, "posts.curate", key, { changes });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const applied = await adminRequest("/rest/v1/rpc/swipeardy_agent_apply_curation", { method: "POST", json: { p_agent_key_id: ctx.agent.id, p_mode: "posts", p_changes: changes } });
  const updated = Array.isArray(applied.data) ? applied.data.map(stripInternal) : [];
  const result = { dry_run: false, mode: "posts", count: updated.length, updated, idempotent_replay: false };
  await writeAudit(ctx, "posts.curate", null, before, updated, { count: updated.length });
  await storeIdempotentResult(ctx, "posts.curate", key, replay.requestHash, result);
  return result;
}

async function readFilterConfig(mode: string): Promise<JsonObject> {
  const { data } = await adminRequest(`/rest/v1/filter_configs?mode=eq.${mode}&select=mode,filters,colors,updated_at&limit=1`);
  const rows = Array.isArray(data) ? data : [];
  return rows[0] ? asObject(rows[0]) : { mode, filters: {}, colors: {}, updated_at: null };
}

export async function listFilters(ctx: RequestContext, args: unknown = {}): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  return await readFilterConfig(normalizeMode(asObject(args || {}, "arguments").mode));
}

export async function updateFilterConfig(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "filters");
  const input = asObject(args, "arguments");
  const mode = normalizeMode(input.mode);
  const filters = asObject(input.filters, "filters");
  const colors = asObject(input.colors, "colors");
  const key = requireIdempotency(input);
  const replay = await readIdempotentResult(ctx, "filters.update", key, { mode, filters, colors });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const before = await readFilterConfig(mode);
  const preview = { mode, filters, colors };
  if (isDryRun(input)) {
    const result = { dry_run: true, before, would_update: preview };
    await writeAudit(ctx, "filters.update.preview", mode, before, result);
    return result;
  }
  const { data } = await adminRequest(`/rest/v1/filter_configs?on_conflict=mode&select=mode,filters,colors,updated_at`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, json: { mode, filters, colors } });
  const result = { dry_run: false, config: Array.isArray(data) && data[0] ? data[0] : preview, idempotent_replay: false };
  await writeAudit(ctx, "filters.update", mode, before, result.config);
  await storeIdempotentResult(ctx, "filters.update", key, replay.requestHash, result);
  return result;
}

export async function listViews(ctx: RequestContext): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  const { data } = await adminRequest("/rest/v1/views_config?id=eq.1&select=data,updated_at&limit=1");
  const rows = Array.isArray(data) ? data : [];
  return rows[0] ? asObject(rows[0]) : { data: [], updated_at: null };
}

function hostIsPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (["localhost", "localhost.localdomain", "0.0.0.0", "::1"].includes(host) || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  }
  return false;
}

async function fetchImage(urlValue: string): Promise<{ bytes: Uint8Array; mimeType: string; url: string }> {
  let parsed: URL;
  try { parsed = new URL(urlValue); } catch { throw new GatewayError(400, "invalid_image_url", "Image URL is invalid"); }
  if (parsed.protocol !== "https:" || hostIsPrivate(parsed.hostname)) throw new GatewayError(400, "invalid_image_url", "Only public HTTPS image URLs are allowed");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response: Response;
  try { response = await fetch(parsed, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "SwipeArdy-Agent-Gateway/1.0" } }); }
  catch { throw new GatewayError(502, "image_fetch_failed", "Image could not be fetched"); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new GatewayError(502, "image_fetch_failed", `Image server returned HTTP ${response.status}`);
  try { if (hostIsPrivate(new URL(response.url).hostname)) throw new GatewayError(400, "invalid_image_url", "Image redirect points to a private host"); } catch (error) { if (error instanceof GatewayError) throw error; }
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) throw new GatewayError(415, "not_an_image", `Resource type '${mimeType || "unknown"}' is not an image`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new GatewayError(413, "image_too_large", "Image exceeds the 5 MB limit");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new GatewayError(413, "image_too_large", "Image exceeds the 5 MB limit");
  return { bytes, mimeType, url: response.url || urlValue };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
}

export async function postToolResult(ctx: RequestContext, record: SwipeRow, includeImages: boolean, maxImages: number): Promise<ToolResult> {
  const safe = stripInternal(record);
  const content: ToolContent[] = [{ type: "text", text: JSON.stringify({ record: safe }) }];
  if (includeImages) {
    const urls = imageList(safe.image).slice(0, Math.min(maxImages, MAX_IMAGES_PER_CALL));
    for (const [index, url] of urls.entries()) {
      try {
        const image = await fetchImage(url);
        content.push({ type: "image", data: bytesToBase64(image.bytes), mimeType: image.mimeType });
        content.push({ type: "text", text: JSON.stringify({ image_index: index, url: image.url, mime_type: image.mimeType, size_bytes: image.bytes.byteLength }) });
      } catch (error) {
        content.push({ type: "text", text: JSON.stringify({ image_index: index, url, error: error instanceof Error ? error.message : "image fetch failed" }) });
      }
    }
  }
  return { content, structuredContent: { record: safe } };
}

export async function getPostImage(ctx: RequestContext, idValue: unknown, modeValue: unknown, indexValue: unknown): Promise<ToolResult> {
  const record = await getPost(ctx, idValue, modeValue);
  const index = cleanInteger(indexValue, "image_index", 0);
  const url = imageList(record.image)[index];
  if (!url) throw new GatewayError(404, "image_not_found", `Record ${record.id} has no image at index ${index}`);
  const image = await fetchImage(url);
  return { content: [{ type: "text", text: JSON.stringify({ record_id: record.id, mode: normalizeMode(modeValue), image_index: index, url: image.url, mime_type: image.mimeType, size_bytes: image.bytes.byteLength }) }, { type: "image", data: bytesToBase64(image.bytes), mimeType: image.mimeType }], structuredContent: { record_id: record.id, image_index: index, url: image.url, mime_type: image.mimeType, size_bytes: image.bytes.byteLength } };
}

async function countForMode(mode: string): Promise<number | null> {
  const response = await adminRequest("/rest/v1/rpc/swipeardy_search_swipes", { method: "POST", headers: { Prefer: "count=exact" }, json: { p_mode: mode, p_limit: 1, p_offset: 0 } });
  const range = response.response.headers.get("content-range") || "";
  const match = /\/(\d+)$/.exec(range);
  return match ? Number(match[1]) : null;
}

export async function status(ctx: RequestContext): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  return { service: "Swipe Ardy Agent Gateway", version: "1.0.0", region: Deno.env.get("SUPABASE_REGION") || "ap-northeast-1", agent: { name: ctx.agent.name, scopes: ctx.agent.scopes }, counts: { posts: await countForMode("posts") } };
}

export async function executeTool(name: string, args: unknown, ctx: RequestContext): Promise<ToolResult> {
  const input = args && typeof args === "object" ? args : {};
  switch (name) {
    case "status": return { content: [{ type: "text", text: JSON.stringify(await status(ctx)) }] };
    case "search_posts": return { content: [{ type: "text", text: JSON.stringify(await searchPosts(ctx, input)) }] };
    case "get_post": {
      const values = asObject(input, "arguments");
      const record = await getPost(ctx, values.id, values.mode);
      return await postToolResult(ctx, record, values.include_images === true, Math.min(cleanInteger(values.max_images, "max_images", 2), MAX_IMAGES_PER_CALL));
    }
    case "get_post_image": {
      const values = asObject(input, "arguments");
      return await getPostImage(ctx, values.post_id, values.mode, values.image_index);
    }
    case "create_post": return { content: [{ type: "text", text: JSON.stringify(await createPost(ctx, input)) }] };
    case "update_post": return { content: [{ type: "text", text: JSON.stringify(await updatePost(ctx, input)) }] };
    case "delete_posts": return { content: [{ type: "text", text: JSON.stringify(await deletePosts(ctx, input)) }] };
    case "list_trash": return { content: [{ type: "text", text: JSON.stringify(await listTrash(ctx, input)) }] };
    case "restore_post": return { content: [{ type: "text", text: JSON.stringify(await restorePost(ctx, input)) }] };
    case "export_posts": return { content: [{ type: "text", text: JSON.stringify(await exportPosts(ctx, input)) }] };
    case "curate_posts": return { content: [{ type: "text", text: JSON.stringify(await curatePosts(ctx, input)) }] };
    case "list_filters": return { content: [{ type: "text", text: JSON.stringify(await listFilters(ctx, input)) }] };
    case "update_filter_config": return { content: [{ type: "text", text: JSON.stringify(await updateFilterConfig(ctx, input)) }] };
    case "list_views": return { content: [{ type: "text", text: JSON.stringify(await listViews(ctx)) }] };
    default: throw new GatewayError(404, "tool_not_found", `Unknown tool '${name}'`);
  }
}
