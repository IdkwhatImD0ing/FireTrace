import { z } from "zod";
import {
  ingestRequestSchema,
  LIMITS,
  SCORE_DATA_TYPES,
  SCORE_LIMITS,
  SCORE_SOURCES,
  SPAN_KINDS,
  STATUSES,
} from "./schema";
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
            "conflict",
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
    scores: {
      type: "object",
      description: "Newest score per name. The full history is at /api/v1/traces/{traceId}/scores.",
      additionalProperties: { $ref: "#/components/schemas/ScoreSummary" },
    },
  },
} as const;

const scoreValueSchema = {
  oneOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }],
  description: "A number for numeric, a string for categorical, a boolean for boolean scores",
} as const;

const scoreSchema = {
  type: "object",
  required: ["id", "traceId", "name", "dataType", "value", "source", "createdAt"],
  properties: {
    id: { type: "string", pattern: "^[0-9a-f]{16}$" },
    traceId: { type: "string", pattern: "^[0-9a-f]{32}$" },
    spanId: { type: ["string", "null"] },
    name: { type: "string" },
    dataType: { type: "string", enum: [...SCORE_DATA_TYPES] },
    value: scoreValueSchema,
    comment: { type: ["string", "null"] },
    source: { type: "string", enum: [...SCORE_SOURCES] },
    evaluatorId: { type: ["string", "null"] },
    runId: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
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
const traceIdParam = {
  name: "traceId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[0-9a-f]{32}$" },
} as const;
const errorRef = {
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
} as const;
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
        MetadataPatch: {
          type: "object",
          required: ["metadata"],
          additionalProperties: false,
          properties: {
            metadata: {
              type: "object",
              additionalProperties: true,
              description:
                "Keys to merge into the trace's metadata. Shallow: a key here replaces that top-level key outright; keys not mentioned are left alone.",
            },
          },
        },
        MetadataPatchResult: {
          type: "object",
          required: ["ok", "traceId", "metadata", "changed", "requestId"],
          properties: {
            ok: { type: "boolean" },
            traceId: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
            changed: {
              type: "boolean",
              description: "False when the merge matched what was already stored; nothing written",
            },
            requestId: { type: "string" },
          },
        },
        TraceSummary: traceSummarySchema,
        Span: spanSchema,
        ScoreSummary: {
          type: "object",
          required: ["scoreId", "dataType", "value", "evaluatorId"],
          properties: {
            scoreId: { type: "string" },
            dataType: { type: "string", enum: [...SCORE_DATA_TYPES] },
            value: scoreValueSchema,
            evaluatorId: { type: ["string", "null"] },
          },
        },
        ScoreInput: {
          type: "object",
          required: ["name", "dataType", "value"],
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              pattern: "^[A-Za-z0-9_-]+$",
              maxLength: SCORE_LIMITS.maxNameLength,
              description: "Doubles as the score's display name; letters, digits, '_' and '-'",
            },
            dataType: { type: "string", enum: [...SCORE_DATA_TYPES] },
            value: scoreValueSchema,
            comment: { type: "string", maxLength: SCORE_LIMITS.maxCommentLength },
            spanId: {
              type: "string",
              pattern: "^[0-9a-fA-F]{16}$",
              description: "Scope the score to one span instead of the whole trace",
            },
          },
        },
        Score: scoreSchema,
        ScorePage: {
          type: "object",
          required: ["scores", "nextCursor", "pageSize"],
          properties: {
            scores: { type: "array", items: { $ref: "#/components/schemas/Score" } },
            nextCursor: { type: ["string", "null"] },
            pageSize: { type: "integer" },
          },
        },
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
            "Requires `traces:read`. Filters combine with AND. Use `after`/`before` cursors from a previous page; never offsets. `sort=slowest` (by durationMs) and `sort=costliest` (by costUsd; traces without a cost are omitted) combine only with `status`, `model`, `name` and `tag`; adding `sessionId`, `userId`, `from` or `to` is a 400. A cursor is only valid under the sort that produced it.",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: [...STATUSES] } },
            { name: "model", in: "query", schema: { type: "string" } },
            {
              name: "name",
              in: "query",
              schema: { type: "string" },
              description: "Exact trace name",
            },
            {
              name: "tag",
              in: "query",
              schema: { type: "string" },
              description: "One tag the trace must carry",
            },
            { name: "sessionId", in: "query", schema: { type: "string" } },
            { name: "userId", in: "query", schema: { type: "string" } },
            {
              name: "sort",
              in: "query",
              schema: {
                type: "string",
                enum: ["newest", "slowest", "costliest"],
                default: "newest",
              },
            },
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
        parameters: [traceIdParam],
        get: {
          operationId: "getTrace",
          summary: "One trace with all of its spans and scores",
          description: "Requires `traces:read`.",
          responses: {
            "200": {
              description: "Trace, spans, and scores",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["trace", "spans", "scores"],
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
                              metadataUpdatedAt: { type: ["string", "null"], format: "date-time" },
                              bodyHash: { type: "string" },
                            },
                          },
                        ],
                      },
                      spans: { type: "array", items: { $ref: "#/components/schemas/Span" } },
                      scores: {
                        type: "array",
                        description: "Every score of the trace, newest first",
                        items: { $ref: "#/components/schemas/Score" },
                      },
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
        patch: {
          operationId: "patchTraceMetadata",
          summary: "Merge keys into a stored trace's metadata",
          description:
            "Requires `traces:write`. The only mutable part of a stored trace: everything it was ingested with stays write-once. The merge is shallow, and `bodyHash` is deliberately not recomputed so re-sending the original trace is still a duplicate rather than a `409`. Metadata is not indexed, so it cannot be filtered, ordered, or aggregated by.",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MetadataPatch" } },
            },
          },
          responses: {
            "200": {
              description: "Merged metadata (written, or unchanged when it matched)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/MetadataPatchResult" },
                },
              },
            },
            "400": {
              description: "Invalid JSON, a field other than metadata, or a key Firestore refuses",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "404": {
              description: "No such trace in this project",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "413": {
              description: "Request over 2 MiB, or the merged document over the per-document limit",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "429": {
              description: "Firestore quota exhausted; nothing written",
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
      "/api/v1/traces/{traceId}/scores": {
        parameters: [traceIdParam],
        post: {
          operationId: "addScore",
          summary: "Attach a score to a stored trace",
          description: `Requires \`traces:write\`. A score is a judgement made after the run: a rating, a reviewer's verdict, an evaluator's result. Scores are append-only; adding a name again records a newer score, and the trace's \`scores\` summary keeps the newest per name. Unlike metadata, scores are indexed: list them per trace or across the project with \`GET /api/v1/scores\`. Limits: ${SCORE_LIMITS.maxPerTrace} scores per trace, names of up to ${SCORE_LIMITS.maxNameLength} characters, comments of up to ${SCORE_LIMITS.maxCommentLength} characters.`,
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ScoreInput" } },
            },
          },
          responses: {
            "201": {
              description: "Stored",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "score", "requestId"],
                    properties: {
                      ok: { type: "boolean" },
                      score: { $ref: "#/components/schemas/Score" },
                      requestId: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Invalid JSON, or a body that is not a score (the message names the field)",
              ...errorRef,
            },
            "404": { description: "No such trace in this project", ...errorRef },
            "409": {
              description: "The trace already holds the maximum number of scores",
              ...errorRef,
            },
            "413": { description: "Request over 2 MiB", ...errorRef },
            "429": { description: "Firestore quota exhausted; nothing written", ...errorRef },
            ...errorResponses,
          },
        },
        get: {
          operationId: "listTraceScores",
          summary: "Every score of one trace, newest first",
          description: "Requires `traces:read`.",
          responses: {
            "200": {
              description: "Scores of the trace",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["traceId", "scores"],
                    properties: {
                      traceId: { type: "string" },
                      scores: { type: "array", items: { $ref: "#/components/schemas/Score" } },
                    },
                  },
                },
              },
            },
            "404": { description: "No such trace in this project", ...errorRef },
            ...errorResponses,
          },
        },
      },
      "/api/v1/traces/{traceId}/scores/{scoreId}": {
        parameters: [
          traceIdParam,
          {
            name: "scoreId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9a-f]{16}$" },
          },
        ],
        delete: {
          operationId: "deleteScore",
          summary: "Delete one score",
          description:
            "Requires `traces:delete`. If it was the newest score of its name, the previous one takes its place in the trace's summary.",
          responses: {
            "200": {
              description: "Deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      traceId: { type: "string" },
                      scoreId: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "No such score on this trace", ...errorRef },
            ...errorResponses,
          },
        },
      },
      "/api/v1/scores": {
        get: {
          operationId: "listScores",
          summary: "List scores across the project newest first with cursor pagination",
          description: "Requires `traces:read`. Filters combine with AND.",
          parameters: [
            {
              name: "name",
              in: "query",
              schema: { type: "string" },
              description: "Exact score name",
            },
            {
              name: "from",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Inclusive lower bound on createdAt",
            },
            {
              name: "to",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Inclusive upper bound on createdAt",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            },
            {
              name: "after",
              in: "query",
              schema: { type: "string" },
              description: "nextCursor from a previous page (older scores)",
            },
          ],
          responses: {
            "200": {
              description: "A page of scores",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ScorePage" } },
              },
            },
            "400": { description: "Invalid cursor or parameter", ...errorRef },
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
