export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Swipe Ardy Agent Gateway",
    version: "1.1.0",
    description: "Scoped AI-agent access to Swipe Ardy. MCP is preferred for multimodal image analysis; REST/OpenAPI is the portable fallback.",
  },
  servers: [{ url: "https://dmhiitzunsdqyxopqsby.supabase.co/functions/v1/swipe-ardy-agent" }],
  security: [{ agentToken: [] }],
  components: {
    securitySchemes: { agentToken: { type: "http", scheme: "bearer", bearerFormat: "swa_ agent token" } },
    schemas: {
      Record: { type: "object", properties: { id: { type: "integer" }, type: { type: ["string", "null"] }, author: { type: "string" }, date: { type: "string" }, platform: { type: "string" }, filters: { type: "object" }, text: { type: "string" }, image: { type: "string" }, postUrl: { type: "string" }, reactions: { type: "integer" }, comments: { type: "integer" }, reposts: { type: "integer" }, followers: { type: ["integer", "null"] }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, revision: { type: "integer" } } },
      Error: { type: "object", properties: { request_id: { type: "string", format: "uuid" }, error: { type: "object" } } },
    },
  },
  paths: {
    "/health": { get: { summary: "Public liveness check", security: [], responses: { "200": { description: "Gateway is running" } } } },
    "/openapi.json": { get: { summary: "OpenAPI document", security: [], responses: { "200": { description: "OpenAPI 3.1 document" } } } },
    "/mcp": { post: { summary: "MCP Streamable HTTP endpoint", description: "JSON-RPC MCP transport with direct image content blocks.", responses: { "200": { description: "MCP response" }, "401": { description: "Missing or invalid agent token" } } } },
    "/api/v1/status": { get: { summary: "Authenticated gateway status", responses: { "200": { description: "Status and scopes" } } } },
    "/api/v1/posts": {
      get: { summary: "Search records", parameters: [{ name: "mode", in: "query", schema: { type: "string", enum: ["posts", "creators", "websites", "snippets"] } }, { name: "query", in: "query", schema: { type: "string" } }, { name: "platform", in: "query", schema: { type: "string" } }, { name: "filters", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", maximum: 200 } }, { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } }], responses: { "200": { description: "Structured records" } } },
      post: { summary: "Create a Posts-mode record", parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" }}], responses: { "200": { description: "Created record or dry-run preview" } } },
    },
    "/api/v1/posts/{id}": {
      get: { summary: "Read one record", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "mode", in: "query", schema: { type: "string" } }, { name: "include_images", in: "query", schema: { type: "boolean" } }], responses: { "200": { description: "Record and optional image blocks" } } },
      patch: { summary: "Revision-checked update of a Posts-mode record", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, { name: "Idempotency-Key", in: "header", schema: { type: "string" }}], responses: { "200": { description: "Updated record or dry-run preview" }, "409": { description: "Revision conflict" } } },
    },
    "/api/v1/posts/delete": { post: { summary: "Preview or confirm recoverable deletion", parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" }}], responses: { "200": { description: "Preview or Trash result" } } } },
    "/api/v1/trash": { get: { summary: "List recoverable deletions", responses: { "200": { description: "Trash items" } } } },
    "/api/v1/trash/{trash_id}/restore": { post: { summary: "Restore a Trash item", parameters: [{ name: "trash_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "Idempotency-Key", in: "header", schema: { type: "string" }}], responses: { "200": { description: "Restored record" } } } },
    "/api/v1/export": { post: { summary: "Create a private structured export", responses: { "200": { description: "Expiring download URL" } } } },
    "/api/v1/curate": { post: { summary: "Preview or atomically apply up to 100 curation patches", responses: { "200": { description: "Preview or updated records" }, "409": { description: "Revision conflict" } } } },
    "/api/v1/images/health": { post: { summary: "Read-only bounded health probe for explicit Posts-mode media URLs", responses: { "200": { description: "Per-media healthy, broken, or uncheckable status" } } } },
    "/api/v1/images/repair": { post: { summary: "Preview or apply a public-browser-discovered Posts-mode image repair", parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string" }}], responses: { "200": { description: "Preview metadata or revision-checked repaired record" }, "409": { description: "Revision conflict or source changed" }, "410": { description: "Preview expired" } } } },
    "/api/v1/filters": { get: { summary: "Read mode filter config", responses: { "200": { description: "Filter definitions and colors" } } }, put: { summary: "Replace mode filter config", responses: { "200": { description: "Updated config or preview" } } } },
    "/api/v1/views": { get: { summary: "Read saved views", responses: { "200": { description: "Saved views" } } } },
  },
} as const;
