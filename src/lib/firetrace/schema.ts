import { z } from "zod";

/**
 * Wire schema for POST /api/v1/traces (schemaVersion 1). Shared with the SDK
 * types in packages/sdk-js/src/types.ts; keep the two in sync.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const LIMITS = {
  maxSpans: 200,
  maxEventsPerSpan: 50,
  maxTags: 20,
  maxTagLength: 64,
  maxNameLength: 500,
  maxIdentifierLength: 200,
  maxRequestBytes: 2 * 1024 * 1024,
  maxDocumentBytes: 750 * 1024,
} as const;

export const SPAN_KINDS = [
  "llm",
  "agent",
  "tool",
  "chain",
  "retriever",
  "embedding",
  "reranker",
  "custom",
] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export const STATUSES = ["ok", "error", "unset"] as const;
export type TraceStatus = (typeof STATUSES)[number];

/**
 * What a stored trace can carry: the wire statuses plus `running`, which the
 * server assigns to a trace ingested without `endedAt` and which only the end
 * request replaces. Clients never send it; filters and readers accept it.
 */
export const STORED_STATUSES = [...STATUSES, "running"] as const;
export type StoredTraceStatus = (typeof STORED_STATUSES)[number];

const isoTimestamp = z
  .string()
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
      !Number.isNaN(Date.parse(v)),
    { message: "must be an ISO 8601 timestamp, e.g. 2026-09-02T19:01:02.120Z" },
  );

const hex = (length: number, label: string) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${length}}$`), {
      message: `${label} must be ${length} hexadecimal characters`,
    })
    .transform((s) => s.toLowerCase());

const nonNegativeInt = z.number().int().min(0);

export const usageSchema = z.strictObject({
  inputTokens: nonNegativeInt.optional(),
  outputTokens: nonNegativeInt.optional(),
  totalTokens: nonNegativeInt.optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export const spanEventSchema = z.strictObject({
  name: z.string().min(1).max(LIMITS.maxNameLength),
  timestamp: isoTimestamp,
  attributes: jsonObjectSchema.optional(),
});

export const spanInputSchema = z.strictObject({
  id: hex(16, "span id"),
  parentSpanId: hex(16, "parentSpanId").nullable().default(null),
  name: z.string().min(1).max(LIMITS.maxNameLength),
  kind: z.enum(SPAN_KINDS).default("custom"),
  status: z.enum(STATUSES).default("unset"),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  provider: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  model: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  attributes: jsonObjectSchema.default({}),
  events: z.array(spanEventSchema).max(LIMITS.maxEventsPerSpan).default([]),
  usage: usageSchema.optional(),
  costUsd: z.number().min(0).optional(),
});
export type SpanInput = z.infer<typeof spanInputSchema>;

/**
 * A trace without `endedAt` is *running*: it is stored as it is, spans are
 * appended with POST /traces/{id}/spans and the run is closed with
 * POST /traces/{id}/end. `status` is decided at that point, so it stays
 * optional here (a default would hide whether it was sent) and normalize.ts
 * rejects it when `endedAt` is absent.
 */
export const traceInputSchema = z.strictObject({
  id: hex(32, "trace id"),
  name: z.string().min(1).max(LIMITS.maxNameLength),
  status: z.enum(STATUSES).optional(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.optional(),
  provider: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  model: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  sessionId: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  userId: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  tags: z.array(z.string().min(1).max(LIMITS.maxTagLength)).max(LIMITS.maxTags).default([]),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  metadata: jsonObjectSchema.default({}),
  usage: usageSchema.default({}),
  costUsd: z.number().min(0).optional(),
  spans: z.array(spanInputSchema).max(LIMITS.maxSpans).default([]),
});
export type TraceInput = z.infer<typeof traceInputSchema>;

export const ingestRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  trace: traceInputSchema,
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

// ---------------------------------------------------------------------------
// Streaming a trace: POST /api/v1/traces/{traceId}/spans appends finished
// spans to a running trace; POST /api/v1/traces/{traceId}/end closes it.
// Spans are immutable once sent, exactly like the whole-trace form.

export const spansRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  spans: z.array(spanInputSchema).min(1).max(LIMITS.maxSpans),
});
export type SpansRequest = z.infer<typeof spansRequestSchema>;

/**
 * Everything a run only knows at the end. `metadata` is shallow-merged into
 * what the start carried, `tags` are added to it; the other fields replace
 * the start's values. `spans` lets the last batch ride along with the end.
 */
export const endRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  endedAt: isoTimestamp,
  status: z.enum(STATUSES).optional(),
  provider: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  model: z.string().min(1).max(LIMITS.maxIdentifierLength).optional(),
  output: jsonValueSchema.optional(),
  usage: usageSchema.optional(),
  costUsd: z.number().min(0).optional(),
  metadata: jsonObjectSchema.optional(),
  tags: z.array(z.string().min(1).max(LIMITS.maxTagLength)).max(LIMITS.maxTags).optional(),
  spans: z.array(spanInputSchema).max(LIMITS.maxSpans).optional(),
});
export type EndRequest = z.infer<typeof endRequestSchema>;

// ---------------------------------------------------------------------------
// Scores (POST /api/v1/traces/{traceId}/scores): judgements attached after the run.

export const SCORE_DATA_TYPES = ["numeric", "categorical", "boolean"] as const;
export type ScoreDataType = (typeof SCORE_DATA_TYPES)[number];

export const SCORE_SOURCES = ["api", "annotation", "eval"] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];

export const SCORE_LIMITS = {
  maxNameLength: 64,
  maxValueLength: 200,
  maxCommentLength: 2000,
  maxPerTrace: 100,
} as const;

/** Score names become field names in the trace's `scores` map, so no dots or spaces. */
export const scoreNameSchema = z
  .string()
  .min(1)
  .max(SCORE_LIMITS.maxNameLength)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "may contain only letters, digits, '_' and '-'" });

const SCORE_VALUE_TYPE: Record<ScoreDataType, "number" | "string" | "boolean"> = {
  numeric: "number",
  categorical: "string",
  boolean: "boolean",
};

export const scoreInputSchema = z
  .strictObject({
    name: scoreNameSchema,
    dataType: z.enum(SCORE_DATA_TYPES),
    value: z.union([z.number(), z.string().min(1).max(SCORE_LIMITS.maxValueLength), z.boolean()]),
    comment: z.string().max(SCORE_LIMITS.maxCommentLength).optional(),
    spanId: hex(16, "spanId").optional(),
  })
  .superRefine((score, ctx) => {
    const expected = SCORE_VALUE_TYPE[score.dataType];
    if (typeof score.value !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `must be a ${expected} when dataType is "${score.dataType}"`,
      });
    }
  });
export type ScoreInput = z.infer<typeof scoreInputSchema>;

/** Human-readable summary of a Zod failure, without echoing payload values. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
