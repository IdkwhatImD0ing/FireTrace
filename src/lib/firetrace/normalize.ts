import { hashCanonical } from "./hash";
import {
  describeIssues,
  ingestRequestSchema,
  LIMITS,
  type JsonObject,
  type JsonValue,
  type SpanInput,
  type SpanKind,
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
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
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

export type NormalizeError = {
  code: "invalid_trace" | "payload_too_large";
  message: string;
};

export type NormalizeResult =
  { ok: true; value: NormalizedIngest } | { ok: false; error: NormalizeError };

function invalid(message: string): NormalizeResult {
  return { ok: false, error: { code: "invalid_trace", message } };
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
  return stripUndefined({
    schemaVersion: 1 as const,
    id: trace.id,
    name: trace.name,
    status: trace.status,
    startedAt: new Date(trace.startedAt).toISOString(),
    endedAt: new Date(trace.endedAt).toISOString(),
    durationMs: durationBetween(trace.startedAt, trace.endedAt),
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

/** Validate and normalize a parsed JSON body. Never throws. */
export function normalizeIngestBody(body: unknown): NormalizeResult {
  const parsed = ingestRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(describeIssues(parsed.error));
  const input = parsed.data.trace;

  if (durationBetween(input.startedAt, input.endedAt) < 0) {
    return invalid("trace.endedAt cannot precede trace.startedAt");
  }

  const seen = new Set<string>();
  for (const span of input.spans) {
    if (seen.has(span.id)) return invalid(`duplicate span id "${span.id}"`);
    seen.add(span.id);
    if (durationBetween(span.startedAt, span.endedAt) < 0) {
      return invalid(`span "${span.id}": endedAt cannot precede startedAt`);
    }
    if (span.parentSpanId === span.id) {
      return invalid(`span "${span.id}" cannot be its own parent`);
    }
    if (span.parentSpanId && !input.spans.some((s) => s.id === span.parentSpanId)) {
      return invalid(`span "${span.id}" references unknown parentSpanId "${span.parentSpanId}"`);
    }
    for (const event of span.events) {
      if (Number.isNaN(Date.parse(event.timestamp))) {
        return invalid(`span "${span.id}": event "${event.name}" has an invalid timestamp`);
      }
    }
  }

  const shapeChecks: Array<[JsonValue | undefined, string]> = [
    [input.input, "trace.input"],
    [input.output, "trace.output"],
    [input.metadata, "trace.metadata"],
    ...input.spans.flatMap((s): Array<[JsonValue | undefined, string]> => [
      [s.input, `span "${s.id}" input`],
      [s.output, `span "${s.id}" output`],
      [s.attributes, `span "${s.id}" attributes`],
      ...s.events.map((e, i): [JsonValue | undefined, string] => [
        e.attributes,
        `span "${s.id}" event #${i + 1} attributes`,
      ]),
    ]),
  ];
  for (const [value, label] of shapeChecks) {
    if (value === undefined) continue;
    const problem = validateJsonShape(value, label);
    if (problem) return invalid(problem);
  }

  const tree = buildSpanTree(input.spans.map((s) => ({ id: s.id, parentSpanId: s.parentSpanId })));
  if (tree.cycles.length > 0) {
    return invalid(`span parent references form a cycle: ${tree.cycles[0].join(" -> ")}`);
  }

  const spans = input.spans.map((s) => normalizeSpan(s, input.id));
  const trace = normalizeTrace(input, spans);

  const traceBytes = byteLength(trace);
  if (Math.max(traceBytes, firestoreSizeEstimate(trace)) > LIMITS.maxDocumentBytes) {
    return {
      ok: false,
      error: {
        code: "payload_too_large",
        message: `trace document is ${traceBytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes. Reduce input/output/metadata size.`,
      },
    };
  }
  let estimatedBytes = traceBytes;
  for (const span of spans) {
    const spanBytes = byteLength(span);
    if (Math.max(spanBytes, firestoreSizeEstimate(span)) > LIMITS.maxDocumentBytes) {
      return {
        ok: false,
        error: {
          code: "payload_too_large",
          message: `span "${span.id}" is ${spanBytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes per span.`,
        },
      };
    }
    estimatedBytes += spanBytes;
  }

  const bodyHash = hashCanonical({ trace, spans } as unknown as JsonValue);
  return { ok: true, value: { trace, spans, bodyHash, estimatedBytes } };
}
