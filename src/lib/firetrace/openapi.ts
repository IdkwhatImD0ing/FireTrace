import { z } from "zod";
import { ingestRequestSchema, LIMITS, SPAN_KINDS, STATUSES } from "./schema";
import { KEY_SCOPES, SCOPE_DESCRIPTIONS } from "./scopes";

/**
 * OpenAPI 3.1 description of the key-authenticated API. Served at
 * /api/v1/openapi.json and mirrored in docs/api.md.
 */
const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: {
        code: {
          type: "string",
          enum: [
            "invalid_json",
            "invalid_trace",
            "invalid_request",
            "invalid_api_key",
            "insufficient_scope",
            "not_found",
            "trace_id_conflict",
            "payload_too_large",
            "quota_exhausted",
            "trial_limit_reached",
            "not_configured",
            "internal_error",
          ],
        },
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
} as const;

const usageSchema = {
  type: "object",
  properties: {
    inputTokens: { type: "integer", minimum: 0 },
    outputTokens: { type: "integer", minimum: 0 },
    totalTokens: { type: "integer", minimum: 0 },
  },
} as const;

const traceSummarySchema = {
  type: "object",
  required: [
    "id",
    "name",
    "status",
    "startedAt",
    "endedAt",
    "durationMs",
    "spanCount",
    "errorCount",
  ],
  properties: {
    id: { type: "string", pattern: "^[0-9a-f]{32}$" },
    name: { type: "string" },
    status: { type: "string", enum: [...STATUSES] },
    startedAt: { type: "string", format: "date-time" },
    endedAt: { type: "string", format: "date-time" },
    durationMs: { type: "integer" },
    provider: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    sessionId: { type: ["string", "null"] },
    userId: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" } },
    usage: usageSchema,
    costUsd: { type: ["number", "null"] },
    spanCount: { type: "integer" },
    errorCount: { type: "integer" },
    estimatedBytes: { type: "integer" },
    ingestedAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;

const spanSchema = {
  type: "object",
  required: [
    "id",
    "traceId",
    "parentSpanId",
    "name",
    "kind",
    "status",
    "startedAt",
    "endedAt",
    "durationMs",
  ],
  properties: {
    id: { type: "string", pattern: "^[0-9a-f]{16}$" },
    traceId: { type: "string" },
    parentSpanId: { type: ["string", "null"] },
    name: { type: "string" },
    kind: { type: "string", enum: [...SPAN_KINDS] },
    status: { type: "string", enum: [...STATUSES] },
    startedAt: { type: "string", format: "date-time" },
    endedAt: { type: "string", format: "date-time" },
    durationMs: { type: "integer" },
    provider: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    input: {},
    output: {},
    attributes: { type: "object", additionalProperties: true },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          attributes: { type: ["object", "null"], additionalProperties: true },
        },
      },
    },
    usage: { ...usageSchema, nullable: true },
    costUsd: { type: ["number", "null"] },
  },
} as const;

export function ingestRequestJsonSchema(): Record<string, unknown> {
  try {
    return z.toJSONSchema(ingestRequestSchema, {
      io: "input",
      target: "draft-2020-12",
      unrepresentable: "any",
    }) as Record<string, unknown>;
  } catch {
    return { type: "object", description: "See docs/ingestion-api.md for the full schema." };
  }
}

const bearer = [{ apiKey: [] }];
const errorResponses = {
  "401": {
    description: "Missing, invalid, revoked, or expired API key",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "403": {
    description:
      "The key lacks the required scope, or (on instances with trial mode) the account has used its trial traces (trial_limit_reached)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "500": {
    description: "Unexpected error or unconfigured deployment (includes a requestId)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
};

export function openApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "FireTrace API",
      version: "1.0.0",
      description:
        "Key-authenticated API of a FireTrace deployment. Every request carries `Authorization: Bearer ft_live_<keyId>_<secret>`; the key decides the project and the scopes. " +
        Object.entries(SCOPE_DESCRIPTIONS)
          .map(([s, d]) => `\`${s}\`: ${d}.`)
          .join(" "),
    },
    servers: [{ url: baseUrl }],
    security: bearer,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ft_live_<keyId>_<secret>",
          description: `Project API key. Scopes: ${KEY_SCOPES.join(", ")}.`,
        },
      },
      schemas: {
        Error: errorSchema,
        IngestRequest: ingestRequestJsonSchema(),
        TraceSummary: traceSummarySchema,
        Span: spanSchema,
        TracePage: {
          type: "object",
          required: ["traces", "nextCursor", "prevCursor", "pageSize"],
          properties: {
            traces: { type: "array", items: { $ref: "#/components/schemas/TraceSummary" } },
            nextCursor: { type: ["string", "null"] },
            prevCursor: { type: ["string", "null"] },
            pageSize: { type: "integer" },
          },
        },
        Project: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            traceCount: { type: "integer" },
            spanCount: { type: "integer" },
            estimatedBytes: {
              type: "integer",
              description:
                "FireTrace's serialized-size estimate, not Firebase's billable measurement",
            },
            lastTraceAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            storage: {
              type: "object",
              properties: {
                limitBytes: { type: "integer" },
                level: { type: "string", enum: ["ok", "warning", "critical"] },
              },
            },
            keyScopes: { type: "array", items: { type: "string", enum: [...KEY_SCOPES] } },
          },
        },
      },
    },
    paths: {
      "/api/v1/project": {
        get: {
          operationId: "getProject",
          summary: "The project this key belongs to, with counters and storage estimate",
          description: "Requires `traces:read`.",
          responses: {
            "200": {
              description: "Project",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Project" } } },
            },
            ...errorResponses,
          },
        },
      },
      "/api/v1/traces": {
        post: {
          operationId: "recordTrace",
          summary: "Record one complete, immutable trace",
          description: `Requires \`traces:write\`. Idempotent per trace id: an identical resend returns 200 with duplicate=true; a different body for the same id returns 409. Limits: ${LIMITS.maxSpans} spans, ${LIMITS.maxEventsPerSpan} events per span, ${LIMITS.maxTags} tags, ${LIMITS.maxRequestBytes} request bytes, ${LIMITS.maxDocumentBytes} bytes per stored document.`,
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/IngestRequest" } },
            },
          },
          responses: {
            "201": {
              description: "Stored",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/IngestResult" } },
              },
            },
            "200": {
              description: "Identical duplicate; nothing written",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/IngestResult" } },
              },
            },
            "400": {
              description: "Invalid JSON or schema violation",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "409": {
              description: "Trace id reused with different content",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "413": {
              description: "Body or document too large",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "429": {
              description: "Firestore quota exhausted; nothing written",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            ...errorResponses,
          },
        },
        get: {
          operationId: "listTraces",
          summary: "List traces newest first with cursor pagination",
          description:
            "Requires `traces:read`. Filters combine with AND. Use `after`/`before` cursors from a previous page; never offsets.",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: [...STATUSES] } },
            { name: "model", in: "query", schema: { type: "string" } },
            { name: "sessionId", in: "query", schema: { type: "string" } },
            { name: "userId", in: "query", schema: { type: "string" } },
            {
              name: "from",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Inclusive lower bound on startedAt",
            },
            {
              name: "to",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Inclusive upper bound on startedAt",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
            {
              name: "after",
              in: "query",
              schema: { type: "string" },
              description: "nextCursor from a previous page (older traces)",
            },
            {
              name: "before",
              in: "query",
              schema: { type: "string" },
              description: "prevCursor from a previous page (newer traces)",
            },
          ],
          responses: {
            "200": {
              description: "A page of traces",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/TracePage" } },
              },
            },
            "400": {
              description: "Invalid cursor or parameter",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            ...errorResponses,
          },
        },
      },
      "/api/v1/traces/{traceId}": {
        parameters: [
          {
            name: "traceId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9a-f]{32}$" },
          },
        ],
        get: {
          operationId: "getTrace",
          summary: "One trace with all of its spans",
          description: "Requires `traces:read`.",
          responses: {
            "200": {
              description: "Trace and spans",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["trace", "spans"],
                    properties: {
                      trace: {
                        allOf: [
                          { $ref: "#/components/schemas/TraceSummary" },
                          {
                            type: "object",
                            properties: {
                              input: {},
                              output: {},
                              metadata: { type: "object" },
                              bodyHash: { type: "string" },
                            },
                          },
                        ],
                      },
                      spans: { type: "array", items: { $ref: "#/components/schemas/Span" } },
                    },
                  },
                },
              },
            },
            "404": {
              description: "No such trace in this project",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            ...errorResponses,
          },
        },
        delete: {
          operationId: "deleteTrace",
          summary: "Delete a trace and all of its spans",
          description:
            "Requires `traces:delete`. This is the only way data leaves Firestore besides the dashboard; FireTrace never deletes on its own.",
          responses: {
            "200": {
              description: "Deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { ok: { type: "boolean" }, traceId: { type: "string" } },
                  },
                },
              },
            },
            "404": {
              description: "No such trace in this project",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            ...errorResponses,
          },
        },
      },
      "/api/mcp": {
        post: {
          operationId: "mcp",
          summary: "Model Context Protocol endpoint (Streamable HTTP, stateless)",
          description:
            "JSON-RPC 2.0 over HTTP as specified by MCP. Authenticate with the same bearer key; the tools offered depend on the key's scopes. See docs/mcp.md.",
          responses: { "200": { description: "JSON-RPC response" }, ...errorResponses },
        },
      },
    },
  };
}

// Kept separate so the components block above stays readable.
export const ingestResultSchema = {
  type: "object",
  required: ["ok", "traceId", "projectId", "spanCount", "duplicate", "requestId"],
  properties: {
    ok: { type: "boolean" },
    traceId: { type: "string" },
    projectId: { type: "string" },
    spanCount: { type: "integer" },
    duplicate: { type: "boolean" },
    requestId: { type: "string" },
  },
} as const;
