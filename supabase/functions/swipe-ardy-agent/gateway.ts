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
const MAX_HEALTH_POSTS_PER_CALL = 25;
const MAX_HEALTH_IMAGES_PER_POST = 8;
const MAX_BULK_REPAIR_ITEMS = 25;
const MAX_BULK_REPAIR_SOURCE_URLS = 25;
const MAX_BULK_REPAIR_CONCURRENCY = 5;
const REPAIR_CONFIRMATION_MS = 15 * 60 * 1000;
const REPAIRED_MEDIA_BUCKET = "swipeardy-repaired-media";
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
    name: "scan_image_health",
    description: "Read-only bounded health check for explicit Posts-mode media. It probes both image and video URLs, never changes data, and reports broken, healthy, or uncheckable media.",
    inputSchema: { type: "object", required: ["post_ids"], properties: { post_ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: MAX_HEALTH_POSTS_PER_CALL }, max_images_per_post: { type: "integer", minimum: 1, maximum: MAX_HEALTH_IMAGES_PER_POST, default: 4 } }, additionalProperties: false },
    annotations: { title: "Scan Swipe Ardy image health", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "repair_post_images",
    description: "Two-step Posts-mode image repair. Preview public browser-discovered source_image_urls first; after human review, apply with the returned confirmation token. Apply copies verified bytes into Swipe Ardy Storage and revision-checks the image update. This never controls a browser or uses LinkedIn credentials.",
    inputSchema: { type: "object", required: ["phase", "idempotency_key"], properties: { phase: { type: "string", enum: ["preview", "apply"] }, post_id: { type: "integer", minimum: 1 }, expected_revision: { type: "integer", minimum: 1 }, source_image_urls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: MAX_IMAGES_PER_CALL }, repair_id: { type: "string", format: "uuid" }, confirmation_token: { type: "string", minLength: 20, maxLength: 200 }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, additionalProperties: false },
    annotations: { title: "Preview or apply Swipe Ardy image repair", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "bulk_repair_post_images",
    description: "Bounded batch image repair for up to 25 Posts. Preview browser-discovered candidates as one manifest, obtain one human approval, then apply with at most five concurrent item repairs. Every item is revision-checked and failures are returned without overwriting unrelated posts.",
    inputSchema: { type: "object", required: ["phase", "idempotency_key"], properties: { phase: { type: "string", enum: ["preview", "apply"] }, items: { type: "array", minItems: 1, maxItems: MAX_BULK_REPAIR_ITEMS, items: { type: "object", required: ["post_id", "expected_revision", "source_image_urls"], properties: { post_id: { type: "integer", minimum: 1 }, expected_revision: { type: "integer", minimum: 1 }, source_image_urls: { type: "array", minItems: 1, maxItems: MAX_IMAGES_PER_CALL, items: { type: "string", format: "uri" } } }, additionalProperties: false } }, batch_id: { type: "string", format: "uuid" }, confirmation_token: { type: "string", minLength: 20, maxLength: 200 }, concurrency: { type: "integer", minimum: 1, maximum: MAX_BULK_REPAIR_CONCURRENCY, default: MAX_BULK_REPAIR_CONCURRENCY }, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } }, additionalProperties: false },
    annotations: { title: "Preview or apply bounded Swipe Ardy bulk image repair", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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

function parsePublicHttpsUrl(urlValue: string, label = "Image URL"): URL {
  let parsed: URL;
  try { parsed = new URL(urlValue); } catch { throw new GatewayError(400, "invalid_image_url", `${label} is invalid`); }
  if (parsed.protocol !== "https:" || hostIsPrivate(parsed.hostname)) {
    throw new GatewayError(400, "invalid_image_url", "Only public HTTPS image URLs are allowed");
  }
  return parsed;
}

function ensurePublicRedirect(urlValue: string): void {
  const parsed = parsePublicHttpsUrl(urlValue, "Image redirect URL");
  if (hostIsPrivate(parsed.hostname)) throw new GatewayError(400, "invalid_image_url", "Image redirect points to a private host");
}

async function readImageBytes(response: Response): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new GatewayError(413, "image_too_large", "Image exceeds the 5 MB limit");
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new GatewayError(413, "image_too_large", "Image exceeds the 5 MB limit");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function fetchImage(urlValue: string, timeoutMilliseconds = 20000): Promise<{ bytes: Uint8Array; mimeType: string; url: string }> {
  const parsed = parsePublicHttpsUrl(urlValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let response: Response;
  try { response = await fetch(parsed, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "SwipeArdy-Agent-Gateway/1.0" } }); }
  catch { throw new GatewayError(502, "image_fetch_failed", "Image could not be fetched"); }
  finally { clearTimeout(timeout); }
  if (!response.ok) throw new GatewayError(502, "image_fetch_failed", `Image server returned HTTP ${response.status}`);
  ensurePublicRedirect(response.url || urlValue);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!mimeType.startsWith("image/")) throw new GatewayError(415, "not_an_image", `Resource type '${mimeType || "unknown"}' is not an image`);
  const bytes = await readImageBytes(response);
  return { bytes, mimeType, url: response.url || urlValue };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ImageHealth = {
  url: string;
  status: "healthy" | "broken" | "uncheckable";
  http_status: number | null;
  mime_type: string | null;
  resolved_url: string | null;
  detail?: string;
};

async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* probe body is deliberately discarded */ }
}

async function probeImage(urlValue: string): Promise<ImageHealth> {
  let parsed: URL;
  try { parsed = parsePublicHttpsUrl(urlValue); }
  catch (error) {
    return { url: urlValue, status: "uncheckable", http_status: null, mime_type: null, resolved_url: null, detail: error instanceof Error ? error.message : "invalid URL" };
  }
  const probe = async (method: "HEAD" | "GET"): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await fetch(parsed, { method, signal: controller.signal, redirect: "follow", headers: { "User-Agent": "SwipeArdy-Agent-Gateway/1.1", ...(method === "GET" ? { Range: "bytes=0-16383" } : {}) } });
    } finally { clearTimeout(timeout); }
  };
  let response: Response;
  try { response = await probe("HEAD"); }
  catch { return { url: urlValue, status: "uncheckable", http_status: null, mime_type: null, resolved_url: null, detail: "network timeout or fetch failure" }; }
  if ([405, 501].includes(response.status)) {
    await cancelResponseBody(response);
    try { response = await probe("GET"); }
    catch { return { url: urlValue, status: "uncheckable", http_status: null, mime_type: null, resolved_url: null, detail: "network timeout or fetch failure" }; }
  }
  const resolvedUrl = response.url || urlValue;
  try { ensurePublicRedirect(resolvedUrl); }
  catch (error) {
    await cancelResponseBody(response);
    return { url: urlValue, status: "uncheckable", http_status: response.status, mime_type: null, resolved_url: null, detail: error instanceof Error ? error.message : "unsafe redirect" };
  }
  const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null;
  const status = response.status;
  await cancelResponseBody(response);
  if (status === 404 || status === 410) return { url: urlValue, status: "broken", http_status: status, mime_type: mimeType, resolved_url: resolvedUrl, detail: "source returned a definitive missing status" };
  if (response.ok && Boolean(mimeType?.startsWith("image/") || mimeType?.startsWith("video/"))) return { url: urlValue, status: "healthy", http_status: status, mime_type: mimeType, resolved_url: resolvedUrl };
  if (response.ok) return { url: urlValue, status: "uncheckable", http_status: status, mime_type: mimeType, resolved_url: resolvedUrl, detail: "source did not identify itself as image or video media" };
  return { url: urlValue, status: "uncheckable", http_status: status, mime_type: mimeType, resolved_url: resolvedUrl, detail: "source denied or could not satisfy a lightweight probe" };
}

function repairImageUrls(value: unknown): string[] {
  const values = asArray(value, "source_image_urls");
  if (!values.length || values.length > MAX_IMAGES_PER_CALL) throw new GatewayError(400, "invalid_input", `source_image_urls must contain between 1 and ${MAX_IMAGES_PER_CALL} URLs`);
  const urls = [...new Set(values.map((item, index) => cleanText(item, `source_image_urls[${index}]`, 4000, true)!))];
  for (const url of urls) parsePublicHttpsUrl(url, "source_image_urls entry");
  return urls;
}

function repairedMediaExtension(mimeType: string): string {
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
  const extension = extensions[mimeType];
  if (!extension) throw new GatewayError(415, "unsupported_image_type", `Image type '${mimeType}' is not supported for repaired media`);
  return extension;
}

function storagePathUrl(bucket: string, path: string): string {
  const base = (Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  if (!base) throw new GatewayError(500, "server_misconfigured", "SUPABASE_URL is unavailable");
  return `${base}/storage/v1/object/public/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadRepairedMedia(path: string, image: { bytes: Uint8Array; mimeType: string }): Promise<void> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  await adminRequest(`/storage/v1/object/${REPAIRED_MEDIA_BUCKET}/${encodedPath}`, {
    method: "POST",
    headers: { "Content-Type": image.mimeType, "x-upsert": "false", "Cache-Control": "public, max-age=31536000, immutable" },
    body: image.bytes,
  });
}

async function uploadRepairedMediaIfAbsent(path: string, image: { bytes: Uint8Array; mimeType: string }): Promise<boolean> {
  try {
    await uploadRepairedMedia(path, image);
    return true;
  } catch (error) {
    // A retry can reach the same immutable content-addressed path after the
    // original request completed its upload but before it persisted the result.
    // The path contains the reviewed SHA-256, so treating that collision as an
    // existing approved object is safe and avoids rewriting the object.
    if (error instanceof GatewayError && error.status === 409) return false;
    throw error;
  }
}

async function removeUploadedRepairedMedia(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await adminRequest(`/storage/v1/object/${REPAIRED_MEDIA_BUCKET}`, { method: "DELETE", json: { prefixes: paths } });
}

async function repairConfirmationToken(ctx: RequestContext, repairId: string): Promise<string> {
  // The token can be regenerated for an idempotent retry without storing its
  // plaintext. The server-only secret makes the proof unguessable even if a
  // repair UUID is somehow observed.
  const secret = Deno.env.get("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new GatewayError(500, "server_misconfigured", "Supabase admin key is unavailable");
  const proof = (await sha256Hex(`${secret}:${ctx.agent.id}:${repairId}`)).slice(0, 48);
  return `swir_${repairId}_${proof}`;
}

function repairMetadata(row: JsonObject): JsonObject {
  return {
    repair_id: row.repair_id,
    post_id: row.post_id,
    expected_revision: row.expected_revision,
    source_post_url: row.source_post_url || null,
    candidate_images: Array.isArray(row.candidate_images) ? row.candidate_images : [],
    confirmation_expires_at: row.expires_at,
  };
}

export async function scanImageHealth(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  const input = asObject(args, "arguments");
  const ids = normalizeIds(input.post_ids, MAX_HEALTH_POSTS_PER_CALL);
  const maxImages = Math.min(Math.max(cleanInteger(input.max_images_per_post, "max_images_per_post", 4), 1), MAX_HEALTH_IMAGES_PER_POST);
  const records = await recordsByIds(ids, "posts");
  const byId = new Map(records.map((record) => [record.id, record]));
  const results: JsonObject[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      results.push({ post_id: id, status: "not_found_or_not_posts_mode" });
      continue;
    }
    const urls = imageList(record.image);
    const scannedUrls = urls.slice(0, maxImages);
    const images: ImageHealth[] = [];
    for (const url of scannedUrls) images.push(await probeImage(url));
    const counts = { healthy: images.filter((item) => item.status === "healthy").length, broken: images.filter((item) => item.status === "broken").length, uncheckable: images.filter((item) => item.status === "uncheckable").length };
    const status = !urls.length ? "no_media" : counts.broken ? "needs_repair" : counts.uncheckable ? "needs_review" : "healthy";
    results.push({ post_id: id, revision: record.revision, post_url: record.postUrl || null, media_count: urls.length, checked_media_count: images.length, omitted_media_count: Math.max(0, urls.length - images.length), status, counts, media: images });
  }
  return { mode: "posts", read_only: true, max_images_per_post: maxImages, count: results.length, records: results };
}

async function createRepairPreview(ctx: RequestContext, input: JsonObject): Promise<JsonObject> {
  const postId = cleanInteger(input.post_id, "post_id");
  const expectedRevision = cleanInteger(input.expected_revision, "expected_revision");
  if (expectedRevision < 1) throw new GatewayError(400, "invalid_input", "expected_revision must be positive");
  const sourceUrls = repairImageUrls(input.source_image_urls);
  const current = await getPost(ctx, postId, "posts");
  if (Number(current.revision) !== expectedRevision) throw new GatewayError(409, "revision_conflict", `Post ${postId} changed since it was read`, { id: postId, expected_revision: expectedRevision, current_revision: current.revision });
  const candidateImages: JsonObject[] = [];
  for (const sourceUrl of sourceUrls) {
    const image = await fetchImage(sourceUrl);
    candidateImages.push({ source_url: sourceUrl, resolved_url: image.url, mime_type: image.mimeType, size_bytes: image.bytes.byteLength, sha256: await hashBytes(image.bytes) });
  }
  const expiresAt = new Date(Date.now() + REPAIR_CONFIRMATION_MS).toISOString();
  const insert = await adminRequest("/rest/v1/swipeardy_agent_image_repairs?select=repair_id,post_id,expected_revision,source_post_url,candidate_images,expires_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    json: { agent_key_id: ctx.agent.id, post_id: postId, expected_revision: expectedRevision, source_post_url: current.postUrl || null, candidate_images: candidateImages, confirmation_hash: "pending", expires_at: expiresAt },
  });
  const row = Array.isArray(insert.data) && insert.data[0] ? asObject(insert.data[0], "repair preview") : null;
  if (!row?.repair_id) throw new GatewayError(502, "repair_preview_failed", "Supabase did not return a repair preview ID");
  const confirmationToken = await repairConfirmationToken(ctx, String(row.repair_id));
  await adminRequest(`/rest/v1/swipeardy_agent_image_repairs?repair_id=eq.${encodeURIComponent(String(row.repair_id))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { confirmation_hash: await sha256Hex(confirmationToken) } });
  const result = { dry_run: true, mode: "posts", ...repairMetadata(row), confirmation_token: confirmationToken, instruction: "Inspect these browser-discovered candidates, then call repair_post_images with phase=apply, repair_id, confirmation_token, expected_revision, and a fresh idempotency_key. No post has changed yet." };
  await writeAudit(ctx, "images.repair.preview", String(postId), current, { ...result, confirmation_token: "[redacted]" }, { candidate_count: candidateImages.length });
  return result;
}

async function applyRepairPreview(ctx: RequestContext, input: JsonObject): Promise<JsonObject> {
  const repairId = cleanText(input.repair_id, "repair_id", 100, true)!;
  const confirmationToken = cleanText(input.confirmation_token, "confirmation_token", 200, true)!;
  const expectedRevision = cleanInteger(input.expected_revision, "expected_revision");
  if (expectedRevision < 1) throw new GatewayError(400, "invalid_input", "expected_revision must be positive");
  const key = requireIdempotency(input);
  const replay = await readIdempotentResult(ctx, "images.repair.apply", key, { repair_id: repairId, expected_revision: expectedRevision });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const query = new URLSearchParams({ select: "*", repair_id: `eq.${repairId}`, agent_key_id: `eq.${ctx.agent.id}`, limit: "1" });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_image_repairs?${query}`);
  const rows = Array.isArray(data) ? data as JsonObject[] : [];
  const repair = rows[0];
  if (!repair) throw new GatewayError(404, "repair_not_found", "Repair preview was not found for this agent");
  if (repair.status !== "previewed") throw new GatewayError(409, "repair_not_applicable", "Repair preview was already applied or is no longer available");
  if (new Date(String(repair.expires_at)).getTime() <= Date.now()) {
    await adminRequest(`/rest/v1/swipeardy_agent_image_repairs?repair_id=eq.${encodeURIComponent(repairId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { status: "expired" } });
    throw new GatewayError(410, "repair_preview_expired", "Repair preview expired; create a new preview before applying");
  }
  if (Number(repair.expected_revision) !== expectedRevision) throw new GatewayError(409, "revision_conflict", "The supplied revision differs from the reviewed repair preview", { expected_revision: repair.expected_revision });
  if (await sha256Hex(confirmationToken) !== String(repair.confirmation_hash)) throw new GatewayError(403, "invalid_confirmation_token", "Repair confirmation token is invalid");
  const postId = cleanInteger(repair.post_id, "repair.post_id");
  const current = await getPost(ctx, postId, "posts");
  if (Number(current.revision) !== expectedRevision) throw new GatewayError(409, "revision_conflict", `Post ${postId} changed since it was previewed`, { id: postId, expected_revision: expectedRevision, current_revision: current.revision });
  const candidates = asArray(repair.candidate_images, "repair.candidate_images").map((value, index) => asObject(value, `repair.candidate_images[${index}]`));
  if (!candidates.length || candidates.length > MAX_IMAGES_PER_CALL) throw new GatewayError(409, "repair_preview_invalid", "Repair preview has no valid candidate images");
  const refetched: Array<{ bytes: Uint8Array; mimeType: string; url: string; candidate: JsonObject }> = [];
  for (const candidate of candidates) {
    const image = await fetchImage(cleanText(candidate.resolved_url || candidate.source_url, "repair candidate URL", 4000, true)!);
    const actualHash = await hashBytes(image.bytes);
    if (actualHash !== String(candidate.sha256) || image.mimeType !== String(candidate.mime_type)) {
      throw new GatewayError(409, "repair_source_changed", "A reviewed source image changed or expired; create a new preview before applying", { source_url: candidate.source_url, resolved_url: image.url });
    }
    refetched.push({ ...image, candidate });
  }
  const uploadedPaths: string[] = [];
  try {
    for (const [index, image] of refetched.entries()) {
      const extension = repairedMediaExtension(image.mimeType);
      const digest = String(image.candidate.sha256).slice(0, 24);
      const path = `posts/${postId}/${repairId}/${String(index + 1).padStart(2, "0")}-${digest}.${extension}`;
      await uploadRepairedMedia(path, image);
      uploadedPaths.push(path);
    }
    const newImage = uploadedPaths.map((path) => storagePathUrl(REPAIRED_MEDIA_BUCKET, path)).join(",");
    const updateQuery = new URLSearchParams({ id: `eq.${postId}`, revision: `eq.${expectedRevision}` });
    const update = await adminRequest(`/rest/v1/swipes?${updateQuery}`, { method: "PATCH", headers: { Prefer: "return=representation" }, json: { image: newImage } });
    const updatedRows = Array.isArray(update.data) ? update.data : [];
    if (!updatedRows.length) {
      const latest = await getPost(ctx, postId, "posts");
      throw new GatewayError(409, "revision_conflict", `Post ${postId} changed while the repair was being applied`, { expected_revision: expectedRevision, current_revision: latest.revision });
    }
    const updated = stripInternal(updatedRows[0]);
    await adminRequest(`/rest/v1/swipeardy_agent_image_repairs?repair_id=eq.${encodeURIComponent(repairId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { status: "applied", applied_object_paths: uploadedPaths, applied_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    const result = { dry_run: false, mode: "posts", repair_id: repairId, record: updated, repaired_image_urls: imageList(updated.image), idempotent_replay: false };
    await writeAudit(ctx, "images.repair.apply", String(postId), current, updated, { repair_id: repairId, object_paths: uploadedPaths });
    await storeIdempotentResult(ctx, "images.repair.apply", key, replay.requestHash, result);
    return result;
  } catch (error) {
    if (uploadedPaths.length) {
      try { await removeUploadedRepairedMedia(uploadedPaths); }
      catch { /* DB was not updated, but surface an audit trail for any rare cleanup failure. */ await writeAudit(ctx, "images.repair.cleanup_failed", String(postId), null, { repair_id: repairId, object_paths: uploadedPaths }, { reason: "post update failed after upload" }); }
    }
    throw error;
  }
}

export async function repairPostImages(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const phase = cleanText(input.phase, "phase", 20, true);
  const key = requireIdempotency(input);
  if (phase === "preview") {
    const postId = cleanInteger(input.post_id, "post_id");
    const expectedRevision = cleanInteger(input.expected_revision, "expected_revision");
    const sourceUrls = repairImageUrls(input.source_image_urls);
    const replay = await readIdempotentResult(ctx, "images.repair.preview", key, { post_id: postId, expected_revision: expectedRevision, source_image_urls: sourceUrls });
    if (replay.response) {
      const previous = asObject(replay.response);
      return { ...previous, confirmation_token: await repairConfirmationToken(ctx, cleanText(previous.repair_id, "repair_id", 100, true)!), idempotent_replay: true };
    }
    const preview = await createRepairPreview(ctx, input);
    const persisted = { ...preview };
    delete persisted.confirmation_token;
    await storeIdempotentResult(ctx, "images.repair.preview", key, replay.requestHash, persisted);
    return preview;
  }
  if (phase === "apply") return await applyRepairPreview(ctx, input);
  throw new GatewayError(400, "invalid_input", "phase must be preview or apply");
}

type BulkRepairInput = {
  postId: number;
  expectedRevision: number;
  sourceUrls: string[];
};

function repairErrorMetadata(error: unknown): JsonObject {
  if (error instanceof GatewayError) return { code: error.code, status: error.status, message: error.message, retryable: isTransientRepairError(error) };
  return { code: "repair_failed", status: 500, message: error instanceof Error ? error.message : "Unknown repair failure", retryable: true };
}

function sameUrlList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bulkRepairSummary(items: JsonObject[]): JsonObject {
  const count = (status: string) => items.filter((item) => item.status === status).length;
  return {
    total: items.length,
    ready: count("previewed"),
    applied: count("applied"),
    failed: count("failed"),
    pending: count("previewed") + count("applying"),
  };
}

function bulkItemCanResume(item: JsonObject): boolean {
  if (item.status === "previewed") return true;
  if (item.status !== "failed") return false;
  const failure = item.failure;
  return Boolean(failure && typeof failure === "object" && !Array.isArray(failure) && (failure as JsonObject).retryable === true);
}

function normalizeBulkRepairItems(value: unknown): BulkRepairInput[] {
  const values = asArray(value, "items");
  if (!values.length || values.length > MAX_BULK_REPAIR_ITEMS) {
    throw new GatewayError(400, "invalid_input", `items must contain between 1 and ${MAX_BULK_REPAIR_ITEMS} entries`);
  }
  const seen = new Set<number>();
  const items = values.map((value, index) => {
    const item = asObject(value, `items[${index}]`);
    const postId = cleanInteger(item.post_id, `items[${index}].post_id`);
    const expectedRevision = cleanInteger(item.expected_revision, `items[${index}].expected_revision`);
    if (postId < 1 || expectedRevision < 1) throw new GatewayError(400, "invalid_input", `items[${index}] requires positive post_id and expected_revision`);
    if (seen.has(postId)) throw new GatewayError(400, "invalid_input", `items contains duplicate post_id ${postId}`);
    seen.add(postId);
    return { postId, expectedRevision, sourceUrls: repairImageUrls(item.source_image_urls) };
  });
  const sourceUrlCount = items.reduce((total, item) => total + item.sourceUrls.length, 0);
  if (sourceUrlCount > MAX_BULK_REPAIR_SOURCE_URLS) {
    throw new GatewayError(400, "invalid_input", `A bulk repair batch can contain at most ${MAX_BULK_REPAIR_SOURCE_URLS} candidate image URLs in total; split carousels into a smaller batch`);
  }
  return items;
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientRepairError(error: unknown): boolean {
  return error instanceof GatewayError && (error.status === 408 || error.status === 429 || error.status >= 500);
}

async function retryTransientImageFetch(url: string): Promise<{ bytes: Uint8Array; mimeType: string; url: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchImage(url, 12000);
    } catch (error) {
      lastError = error;
      if (!isTransientRepairError(error) || attempt === 1) throw error;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new GatewayError(502, "image_fetch_failed", "Image could not be fetched");
}

async function bulkRepairConfirmationToken(ctx: RequestContext, batchId: string): Promise<string> {
  const secret = Deno.env.get("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new GatewayError(500, "server_misconfigured", "Supabase admin key is unavailable");
  const proof = (await sha256Hex(`${secret}:bulk-repair:${ctx.agent.id}:${batchId}`)).slice(0, 48);
  return `swib_${batchId}_${proof}`;
}

function batchItemPaths(batchId: string, item: JsonObject): string[] {
  const postId = cleanInteger(item.post_id, "batch item post_id");
  const itemIndex = cleanInteger(item.item_index, "batch item index");
  const candidates = asArray(item.candidate_images, "batch item candidate_images").map((value, index) => asObject(value, `batch item candidate_images[${index}]`));
  if (!candidates.length || candidates.length > MAX_IMAGES_PER_CALL) throw new GatewayError(409, "batch_preview_invalid", "Batch preview has no valid candidate images");
  return candidates.map((candidate, imageIndex) => {
    const digest = cleanText(candidate.sha256, "candidate sha256", 64, true)!;
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw new GatewayError(409, "batch_preview_invalid", "Batch preview contains an invalid image hash");
    const extension = repairedMediaExtension(cleanText(candidate.mime_type, "candidate mime_type", 100, true)!);
    return `posts/${postId}/bulk/${batchId}/${String(itemIndex + 1).padStart(2, "0")}/${String(imageIndex + 1).padStart(2, "0")}-${digest.slice(0, 24)}.${extension}`;
  });
}

function bulkBatchMetadata(row: JsonObject): JsonObject {
  const items = asArray(row.items, "batch items").map((item, index) => asObject(item, `batch items[${index}]`));
  return {
    batch_id: row.batch_id,
    mode: "posts",
    status: row.status,
    item_count: row.item_count,
    summary: row.summary || bulkRepairSummary(items),
    confirmation_expires_at: row.expires_at,
    items,
  };
}

async function previewBulkRepairItem(ctx: RequestContext, item: BulkRepairInput, itemIndex: number): Promise<JsonObject> {
  let current: SwipeRow | null = null;
  try {
    current = await getPost(ctx, item.postId, "posts");
    if (Number(current.revision) !== item.expectedRevision) {
      throw new GatewayError(409, "revision_conflict", `Post ${item.postId} changed since it was read`, { id: item.postId, expected_revision: item.expectedRevision, current_revision: current.revision });
    }
    const candidateImages: JsonObject[] = [];
    for (const sourceUrl of item.sourceUrls) {
      const image = await retryTransientImageFetch(sourceUrl);
      candidateImages.push({ source_url: sourceUrl, resolved_url: image.url, mime_type: image.mimeType, size_bytes: image.bytes.byteLength, sha256: await hashBytes(image.bytes) });
    }
    return {
      item_index: itemIndex,
      post_id: item.postId,
      expected_revision: item.expectedRevision,
      source_post_url: current.postUrl || null,
      original_image_urls: imageList(current.image),
      candidate_images: candidateImages,
      status: "previewed",
      applied_object_paths: [],
      failure: null,
    };
  } catch (error) {
    return {
      item_index: itemIndex,
      post_id: item.postId,
      expected_revision: item.expectedRevision,
      source_post_url: current?.postUrl || null,
      original_image_urls: current ? imageList(current.image) : [],
      candidate_images: [],
      status: "failed",
      applied_object_paths: [],
      failure: repairErrorMetadata(error),
    };
  }
}

async function createBulkRepairPreview(ctx: RequestContext, items: BulkRepairInput[]): Promise<JsonObject> {
  const previewItems = await mapWithConcurrency(items, MAX_BULK_REPAIR_CONCURRENCY, (item, index) => previewBulkRepairItem(ctx, item, index));
  const summary = bulkRepairSummary(previewItems);
  const expiresAt = new Date(Date.now() + REPAIR_CONFIRMATION_MS).toISOString();
  const status = Number(summary.ready || 0) > 0 ? "previewed" : "failed";
  const insert = await adminRequest("/rest/v1/swipeardy_agent_image_repair_batches?select=batch_id,status,item_count,items,summary,expires_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    json: { agent_key_id: ctx.agent.id, status, item_count: previewItems.length, items: previewItems, summary, confirmation_hash: "pending", expires_at: expiresAt },
  });
  const row = Array.isArray(insert.data) && insert.data[0] ? asObject(insert.data[0], "bulk repair preview") : null;
  if (!row?.batch_id) throw new GatewayError(502, "bulk_repair_preview_failed", "Supabase did not return a bulk repair batch ID");
  const confirmationToken = await bulkRepairConfirmationToken(ctx, String(row.batch_id));
  await adminRequest(`/rest/v1/swipeardy_agent_image_repair_batches?batch_id=eq.${encodeURIComponent(String(row.batch_id))}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { confirmation_hash: await sha256Hex(confirmationToken) } });
  const result = {
    dry_run: true,
    ...bulkBatchMetadata(row),
    confirmation_token: confirmationToken,
    instruction: "Review the batch manifest. Only previewed items are eligible. Then call bulk_repair_post_images with phase=apply, batch_id, confirmation_token, and a fresh idempotency_key. Each item remains revision-checked; failures are reported without overwriting other posts.",
  };
  await writeAudit(ctx, "images.repair.batch.preview", String(row.batch_id), null, { ...result, confirmation_token: "[redacted]" }, { item_count: previewItems.length, ready_count: summary.ready, failed_count: summary.failed, concurrency: MAX_BULK_REPAIR_CONCURRENCY });
  return result;
}

async function applyBulkRepairItem(ctx: RequestContext, batchId: string, item: JsonObject): Promise<JsonObject> {
  const uploadedPaths: string[] = [];
  let current: SwipeRow | null = null;
  try {
    const postId = cleanInteger(item.post_id, "batch item post_id");
    const expectedRevision = cleanInteger(item.expected_revision, "batch item expected_revision");
    if (postId < 1 || expectedRevision < 1) throw new GatewayError(409, "batch_preview_invalid", "Batch preview contains an invalid post ID or revision");
    const candidates = asArray(item.candidate_images, "batch item candidate_images").map((value, index) => asObject(value, `batch item candidate_images[${index}]`));
    const paths = batchItemPaths(batchId, item);
    const desiredUrls = paths.map((path) => storagePathUrl(REPAIRED_MEDIA_BUCKET, path));
    current = await getPost(ctx, postId, "posts");
    if (sameUrlList(imageList(current.image), desiredUrls)) {
      return { ...item, status: "applied", applied_object_paths: paths, applied_at: item.applied_at || current.updated_at || new Date().toISOString(), failure: null, recovered_after_retry: true };
    }
    if (Number(current.revision) !== expectedRevision) {
      throw new GatewayError(409, "revision_conflict", `Post ${postId} changed since the batch preview`, { id: postId, expected_revision: expectedRevision, current_revision: current.revision });
    }
    const refetched: Array<{ bytes: Uint8Array; mimeType: string; url: string; candidate: JsonObject }> = [];
    for (const candidate of candidates) {
      const image = await retryTransientImageFetch(cleanText(candidate.resolved_url || candidate.source_url, "batch repair candidate URL", 4000, true)!);
      const actualHash = await hashBytes(image.bytes);
      if (actualHash !== String(candidate.sha256) || image.mimeType !== String(candidate.mime_type)) {
        throw new GatewayError(409, "repair_source_changed", "A reviewed source image changed or expired; create a new batch preview before applying", { source_url: candidate.source_url, resolved_url: image.url });
      }
      refetched.push({ ...image, candidate });
    }
    for (const [index, image] of refetched.entries()) {
      const wasUploaded = await uploadRepairedMediaIfAbsent(paths[index], image);
      if (wasUploaded) uploadedPaths.push(paths[index]);
    }
    const updateQuery = new URLSearchParams({ id: `eq.${postId}`, revision: `eq.${expectedRevision}` });
    const update = await adminRequest(`/rest/v1/swipes?${updateQuery}`, { method: "PATCH", headers: { Prefer: "return=representation" }, json: { image: desiredUrls.join(",") } });
    const updatedRows = Array.isArray(update.data) ? update.data : [];
    if (!updatedRows.length) {
      const latest = await getPost(ctx, postId, "posts");
      if (sameUrlList(imageList(latest.image), desiredUrls)) {
        return { ...item, status: "applied", applied_object_paths: paths, applied_at: latest.updated_at || new Date().toISOString(), failure: null, recovered_after_retry: true };
      }
      throw new GatewayError(409, "revision_conflict", `Post ${postId} changed while the batch was being applied`, { expected_revision: expectedRevision, current_revision: latest.revision });
    }
    const updated = stripInternal(updatedRows[0]);
    const result = { ...item, status: "applied", applied_object_paths: paths, applied_at: new Date().toISOString(), failure: null, record: updated };
    await writeAudit(ctx, "images.repair.batch.apply", String(postId), current, updated, { batch_id: batchId, object_paths: paths });
    return result;
  } catch (error) {
    if (uploadedPaths.length) {
      try { await removeUploadedRepairedMedia(uploadedPaths); }
      catch { await writeAudit(ctx, "images.repair.batch.cleanup_failed", String(item.post_id || ""), null, { batch_id: batchId, object_paths: uploadedPaths }, { reason: "post update failed after upload" }).catch(() => undefined); }
    }
    return { ...item, status: "failed", failure: repairErrorMetadata(error), applied_object_paths: item.applied_object_paths || [] };
  }
}

async function applyBulkRepairBatch(ctx: RequestContext, input: JsonObject): Promise<JsonObject> {
  const batchId = cleanText(input.batch_id, "batch_id", 100, true)!;
  const confirmationToken = cleanText(input.confirmation_token, "confirmation_token", 200, true)!;
  const key = requireIdempotency(input);
  const concurrency = Math.min(Math.max(cleanInteger(input.concurrency, "concurrency", MAX_BULK_REPAIR_CONCURRENCY), 1), MAX_BULK_REPAIR_CONCURRENCY);
  const replay = await readIdempotentResult(ctx, "images.repair.batch.apply", key, { batch_id: batchId, concurrency });
  if (replay.response) return { ...asObject(replay.response), idempotent_replay: true };
  const query = new URLSearchParams({ select: "*", batch_id: `eq.${batchId}`, agent_key_id: `eq.${ctx.agent.id}`, limit: "1" });
  const { data } = await adminRequest(`/rest/v1/swipeardy_agent_image_repair_batches?${query}`);
  const rows = Array.isArray(data) ? data as JsonObject[] : [];
  const batch = rows[0];
  if (!batch) throw new GatewayError(404, "bulk_repair_batch_not_found", "Bulk repair preview was not found for this agent");
  if (new Date(String(batch.expires_at)).getTime() <= Date.now()) {
    await adminRequest(`/rest/v1/swipeardy_agent_image_repair_batches?batch_id=eq.${encodeURIComponent(batchId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { status: "expired", updated_at: new Date().toISOString() } });
    throw new GatewayError(410, "bulk_repair_preview_expired", "Bulk repair preview expired; create a new preview before applying");
  }
  if (!["previewed", "applying", "partial", "applied", "failed"].includes(String(batch.status))) {
    throw new GatewayError(409, "bulk_repair_not_applicable", "Bulk repair preview is no longer available");
  }
  if (await sha256Hex(confirmationToken) !== String(batch.confirmation_hash)) throw new GatewayError(403, "invalid_confirmation_token", "Bulk repair confirmation token is invalid");
  const originalItems = asArray(batch.items, "batch items").map((item, index) => asObject(item, `batch items[${index}]`));
  const eligible = originalItems.filter(bulkItemCanResume);
  if (!eligible.length) {
    const result = { dry_run: false, ...bulkBatchMetadata(batch), idempotent_replay: false, instruction: "This batch has no pending previewed items. Review the manifest; failed items need a new preview with fresh candidates." };
    await storeIdempotentResult(ctx, "images.repair.batch.apply", key, replay.requestHash, result);
    return result;
  }
  await adminRequest(`/rest/v1/swipeardy_agent_image_repair_batches?batch_id=eq.${encodeURIComponent(batchId)}&agent_key_id=eq.${encodeURIComponent(ctx.agent.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, json: { status: "applying", attempt_count: cleanInteger(batch.attempt_count, "batch attempt_count", 0) + 1, updated_at: new Date().toISOString() } });
  const processedItems = await mapWithConcurrency(originalItems, concurrency, async (item) => bulkItemCanResume(item) ? await applyBulkRepairItem(ctx, batchId, item) : item);
  const summary = bulkRepairSummary(processedItems);
  const nextStatus = Number(summary.failed || 0) === 0 && Number(summary.applied || 0) === processedItems.length ? "applied" : Number(summary.applied || 0) > 0 ? "partial" : "failed";
  const completedAt = nextStatus === "applied" ? new Date().toISOString() : null;
  const { data: updatedData } = await adminRequest(`/rest/v1/swipeardy_agent_image_repair_batches?batch_id=eq.${encodeURIComponent(batchId)}&agent_key_id=eq.${encodeURIComponent(ctx.agent.id)}&select=batch_id,status,item_count,items,summary,expires_at`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    json: { status: nextStatus, items: processedItems, summary, applied_at: completedAt, updated_at: new Date().toISOString() },
  });
  const updatedBatch = Array.isArray(updatedData) && updatedData[0] ? asObject(updatedData[0], "updated bulk repair batch") : { ...batch, status: nextStatus, items: processedItems, summary };
  const result = { dry_run: false, ...bulkBatchMetadata(updatedBatch), idempotent_replay: false };
  await writeAudit(ctx, "images.repair.batch.apply", batchId, { status: batch.status, summary: batch.summary }, result, { concurrency, attempted_count: eligible.length, applied_count: summary.applied, failed_count: summary.failed });
  await storeIdempotentResult(ctx, "images.repair.batch.apply", key, replay.requestHash, result);
  return result;
}

export async function bulkRepairPostImages(ctx: RequestContext, args: unknown): Promise<JsonObject> {
  requireScope(ctx.agent, "write");
  const input = asObject(args, "arguments");
  const phase = cleanText(input.phase, "phase", 20, true);
  const key = requireIdempotency(input);
  if (phase === "preview") {
    const items = normalizeBulkRepairItems(input.items);
    const replay = await readIdempotentResult(ctx, "images.repair.batch.preview", key, { items: items.map((item) => ({ post_id: item.postId, expected_revision: item.expectedRevision, source_image_urls: item.sourceUrls })) });
    if (replay.response) {
      const previous = asObject(replay.response);
      return { ...previous, confirmation_token: await bulkRepairConfirmationToken(ctx, cleanText(previous.batch_id, "batch_id", 100, true)!), idempotent_replay: true };
    }
    const preview = await createBulkRepairPreview(ctx, items);
    const persisted = { ...preview };
    delete persisted.confirmation_token;
    await storeIdempotentResult(ctx, "images.repair.batch.preview", key, replay.requestHash, persisted);
    return preview;
  }
  if (phase === "apply") return await applyBulkRepairBatch(ctx, input);
  throw new GatewayError(400, "invalid_input", "phase must be preview or apply");
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
  const response = await adminRequest("/rest/v1/rpc/swipeardy_count_swipes", { method: "POST", json: { p_mode: mode } });
  if (typeof response.data === "number") return response.data;
  if (Array.isArray(response.data) && response.data[0] && typeof response.data[0] === "object") {
    const value = Object.values(response.data[0] as Record<string, unknown>)[0];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(response.data);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function status(ctx: RequestContext): Promise<JsonObject> {
  requireScope(ctx.agent, "read");
  return { service: "Swipe Ardy Agent Gateway", version: "1.2.0", region: Deno.env.get("SUPABASE_REGION") || "ap-northeast-1", agent: { name: ctx.agent.name, scopes: ctx.agent.scopes }, counts: { posts: await countForMode("posts") }, features: { image_health: true, browser_discovered_image_repair: true, bounded_bulk_image_repair: true } };
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
    case "scan_image_health": return { content: [{ type: "text", text: JSON.stringify(await scanImageHealth(ctx, input)) }] };
    case "repair_post_images": return { content: [{ type: "text", text: JSON.stringify(await repairPostImages(ctx, input)) }] };
    case "bulk_repair_post_images": return { content: [{ type: "text", text: JSON.stringify(await bulkRepairPostImages(ctx, input)) }] };
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

