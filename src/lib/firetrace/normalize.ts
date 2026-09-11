import { hashCanonical } from "./hash";
import {
  describeIssues,
  endRequestSchema,
  ingestRequestSchema,
  LIMITS,
  spansRequestSchema,
  type JsonObject,
  type JsonValue,
  type SpanInput,
  type SpanKind,
  type StoredTraceStatus,
  type TraceInput,
  type TraceStatus,
  type Usage,
} from "./schema";
import { firestoreSizeEstimate, validateJsonShape } from "./json-shape";
import { buildSpanTree } from "./tree";

/**
 * Server-side normalization of an ingest request. Output is plain JSON
 * (timestamps as ISO strings) so it can be hashed canonically; Firestore
 * Timestamps are applied when documents are written.
 */
export interface NormalizedSpan {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider?: string;
  model?: string;
  input?: JsonValue;
  output?: JsonValue;
  attributes: JsonObject;
  events: Array<{ name: string; timestamp: string; attributes?: JsonObject }>;
  usage?: Usage;
  costUsd?: number;
}

export interface NormalizedTrace {
  schemaVersion: 1;
  id: string;
  name: string;
  /** `running` until the end request arrives, then one of the wire statuses. */
  status: StoredTraceStatus;
  startedAt: string;
  /** Absent while the trace is running. */
  endedAt?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  sessionId?: string;
  userId?: string;
  tags: string[];
  input?: JsonValue;
  output?: JsonValue;
  metadata: JsonObject;
  usage: Usage;
  costUsd?: number;
  spanCount: number;
  errorCount: number;
}

export interface NormalizedIngest {
  trace: NormalizedTrace;
  spans: NormalizedSpan[];
  /** SHA-256 of the canonical JSON of {trace, spans}. */
  bodyHash: string;
  /** Serialized size of the trace document plus every span document. */
  estimatedBytes: number;
}

/** Finished spans for POST /traces/{id}/spans, or the tail of an end request. */
export interface NormalizedSpanBatch {
  spans: NormalizedSpan[];
}

/** POST /traces/{id}/end after validation; everything optional was omitted by the client. */
export interface NormalizedEnd {
  endedAt: string;
  status: TraceStatus;
  provider?: string;
  model?: string;
  output?: JsonValue;
  usage?: Usage;
  costUsd?: number;
  metadata?: JsonObject;
  tags?: string[];
  spans: NormalizedSpan[];
  /** SHA-256 of the canonical JSON of the normalized end body, for idempotent retries. */
  endHash: string;
}

export type NormalizeError = {
  code: "invalid_trace" | "payload_too_large";
  message: string;
};

export type NormalizeResult<T = NormalizedIngest> =
  { ok: true; value: T } | { ok: false; error: NormalizeError };

function invalid<T>(message: string): NormalizeResult<T> {
  return { ok: false, error: { code: "invalid_trace", message } };
}

function tooLarge<T>(message: string): NormalizeResult<T> {
  return { ok: false, error: { code: "payload_too_large", message } };
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function durationBetween(startedAt: string, endedAt: string): number {
  return Date.parse(endedAt) - Date.parse(startedAt);
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Content hash of one normalized span; stored on the span document so a resend is recognised. */
export function spanHash(span: NormalizedSpan): string {
  return hashCanonical(span as unknown as JsonValue);
}

function normalizeSpan(span: SpanInput, traceId: string): NormalizedSpan {
  return stripUndefined({
    id: span.id,
    traceId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    startedAt: new Date(span.startedAt).toISOString(),
    endedAt: new Date(span.endedAt).toISOString(),
    durationMs: durationBetween(span.startedAt, span.endedAt),
    provider: span.provider,
    model: span.model,
    input: span.input,
    output: span.output,
    attributes: span.attributes,
    events: span.events.map((e) =>
      stripUndefined({
        name: e.name,
        timestamp: new Date(e.timestamp).toISOString(),
        attributes: e.attributes,
      }),
    ),
    usage: span.usage,
    costUsd: span.costUsd,
  });
}

function normalizeTrace(trace: TraceInput, spans: NormalizedSpan[]): NormalizedTrace {
  const endedAt = trace.endedAt;
  return stripUndefined({
    schemaVersion: 1 as const,
    id: trace.id,
    name: trace.name,
    status: endedAt === undefined ? ("running" as const) : (trace.status ?? "unset"),
    startedAt: new Date(trace.startedAt).toISOString(),
    endedAt: endedAt === undefined ? undefined : new Date(endedAt).toISOString(),
    durationMs: endedAt === undefined ? undefined : durationBetween(trace.startedAt, endedAt),
    provider: trace.provider,
    model: trace.model,
    sessionId: trace.sessionId,
    userId: trace.userId,
    tags: trace.tags,
    input: trace.input,
    output: trace.output,
    metadata: trace.metadata,
    usage: trace.usage,
    costUsd: trace.costUsd,
    spanCount: spans.length,
    errorCount: spans.filter((s) => s.status === "error").length,
  });
}

/**
 * The checks every span needs. `knownParents` (the whole-trace form) also
 * requires each parent to be in the set; a streamed batch skips that because
 * children normally finish, and arrive, before their parent.
 */
function checkSpans(spans: SpanInput[], knownParents?: Set<string>): string | null {
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.id)) return `duplicate span id "${span.id}"`;
    seen.add(span.id);
    if (durationBetween(span.startedAt, span.endedAt) < 0) {
      return `span "${span.id}": endedAt cannot precede startedAt`;
    }
    if (span.parentSpanId === span.id) return `span "${span.id}" cannot be its own parent`;
    if (knownParents && span.parentSpanId && !knownParents.has(span.parentSpanId)) {
      return `span "${span.id}" references unknown parentSpanId "${span.parentSpanId}"`;
    }
    for (const event of span.events) {
      if (Number.isNaN(Date.parse(event.timestamp))) {
        return `span "${span.id}": event "${event.name}" has an invalid timestamp`;
      }
    }
  }
  return null;
}

type ShapeCheck = [JsonValue | undefined, string];

function spanShapeChecks(spans: SpanInput[]): ShapeCheck[] {
  return spans.flatMap((s): ShapeCheck[] => [
    [s.input, `span "${s.id}" input`],
    [s.output, `span "${s.id}" output`],
    [s.attributes, `span "${s.id}" attributes`],
    ...s.events.map((e, i): ShapeCheck => [
      e.attributes,
      `span "${s.id}" event #${i + 1} attributes`,
    ]),
  ]);
}

function checkShapes(checks: ShapeCheck[]): string | null {
  for (const [value, label] of checks) {
    if (value === undefined) continue;
    const problem = validateJsonShape(value, label);
    if (problem) return problem;
  }
  return null;
}

/** Sum of the span documents' sizes, or the first span over the per-document limit. */
function sizeSpans(spans: NormalizedSpan[]): { bytes: number } | { message: string } {
  let bytes = 0;
  for (const span of spans) {
    const spanBytes = byteLength(span);
    if (Math.max(spanBytes, firestoreSizeEstimate(span)) > LIMITS.maxDocumentBytes) {
      return {
        message: `span "${span.id}" is ${spanBytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes per span.`,
      };
    }
    bytes += spanBytes;
  }
  return { bytes };
}

function normalizeSpanBatch(
  input: SpanInput[],
  traceId: string,
): NormalizeResult<NormalizedSpanBatch> {
  const problem = checkSpans(input) ?? checkShapes(spanShapeChecks(input));
  if (problem) return invalid(problem);
  const spans = input.map((s) => normalizeSpan(s, traceId));
  const sized = sizeSpans(spans);
  if ("message" in sized) return tooLarge(sized.message);
  return { ok: true, value: { spans } };
}

/**
 * Validate and normalize a parsed JSON body. Never throws. A trace without
 * `endedAt` comes back with `status: "running"` and no `endedAt`/`durationMs`.
 */
export function normalizeIngestBody(body: unknown): NormalizeResult {
  const parsed = ingestRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  const input = parsed.data.trace;

  if (input.endedAt === undefined && input.status !== undefined) {
    return invalid(
      "trace.status is decided by the end request; omit it when endedAt is absent (the trace is stored as running)",
    );
  }
  if (input.endedAt !== undefined && durationBetween(input.startedAt, input.endedAt) < 0) {
    return invalid("trace.endedAt cannot precede trace.startedAt");
  }

  const spanProblem = checkSpans(input.spans, new Set(input.spans.map((s) => s.id)));
  if (spanProblem) return invalid(spanProblem);

  const shapeProblem = checkShapes([
    [input.input, "trace.input"],
    [input.output, "trace.output"],
    [input.metadata, "trace.metadata"],
    ...spanShapeChecks(input.spans),
  ]);
  if (shapeProblem) return invalid(shapeProblem);

  const tree = buildSpanTree(input.spans.map((s) => ({ id: s.id, parentSpanId: s.parentSpanId })));
  if (tree.cycles.length > 0) {
    return invalid(`span parent references form a cycle: ${tree.cycles[0].join(" -> ")}`);
  }

  const spans = input.spans.map((s) => normalizeSpan(s, input.id));
  const trace = normalizeTrace(input, spans);

  const traceBytes = byteLength(trace);
  if (Math.max(traceBytes, firestoreSizeEstimate(trace)) > LIMITS.maxDocumentBytes) {
    return tooLarge(
      `trace document is ${traceBytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes. Reduce input/output/metadata size.`,
    );
  }
  const sized = sizeSpans(spans);
  if ("message" in sized) return tooLarge(sized.message);

  const bodyHash = hashCanonical({ trace, spans } as unknown as JsonValue);
  return { ok: true, value: { trace, spans, bodyHash, estimatedBytes: traceBytes + sized.bytes } };
}

/** POST /traces/{traceId}/spans: a batch of finished spans. Never throws. */
export function normalizeSpansBody(
  body: unknown,
  traceId: string,
): NormalizeResult<NormalizedSpanBatch> {
  const parsed = spansRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  return normalizeSpanBatch(parsed.data.spans, traceId);
}

/**
 * POST /traces/{traceId}/end. `endedAt >= startedAt` is checked in the
 * transaction, where the stored start is known. Never throws.
 */
export function normalizeEndBody(body: unknown, traceId: string): NormalizeResult<NormalizedEnd> {
  const parsed = endRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  const input = parsed.data;

  const shapeProblem = checkShapes([
    [input.output, "output"],
    [input.metadata, "metadata"],
  ]);
  if (shapeProblem) return invalid(shapeProblem);
  const batch = normalizeSpanBatch(input.spans ?? [], traceId);
  if (!batch.ok) return batch;

  const end = stripUndefined({
    endedAt: new Date(input.endedAt).toISOString(),
    status: input.status ?? ("unset" as const),
    provider: input.provider,
    model: input.model,
    output: input.output,
    usage: input.usage,
    costUsd: input.costUsd,
    metadata: input.metadata,
    tags: input.tags,
  });
  const endBytes = byteLength(end);
  if (Math.max(endBytes, firestoreSizeEstimate(end)) > LIMITS.maxDocumentBytes) {
    return tooLarge(
      `end body is ${endBytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes. Reduce output/metadata size.`,
    );
  }
  const endHash = hashCanonical({ end, spans: batch.value.spans } as unknown as JsonValue);
  return { ok: true, value: { ...end, spans: batch.value.spans, endHash } };
}
