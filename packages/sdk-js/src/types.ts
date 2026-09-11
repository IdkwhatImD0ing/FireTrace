/**
 * Wire format for POST /api/v1/traces (schemaVersion 1). Mirrors
 * src/lib/firetrace/schema.ts in the FireTrace app; keep the two in sync.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TraceStatus = "ok" | "error" | "unset";

/** What a stored trace reports back: the wire statuses plus `running` for a streamed trace that has not ended. */
export type StoredTraceStatus = TraceStatus | "running";

export type SpanKind =
  "llm" | "agent" | "tool" | "chain" | "retriever" | "embedding" | "reranker" | "custom";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface SpanEventPayload {
  name: string;
  timestamp: string;
  attributes?: JsonObject;
}

export interface SpanPayload {
  id: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
  provider?: string;
  model?: string;
  input?: JsonValue;
  output?: JsonValue;
  attributes: JsonObject;
  events: SpanEventPayload[];
  usage?: Usage;
  costUsd?: number;
}

export interface TracePayload {
  id: string;
  name: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
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
  spans: SpanPayload[];
}

/**
 * The first request of a streamed trace: everything known when the run
 * starts. No `endedAt` (that is what makes the trace *running* on the
 * server), no `status` (decided at the end) and no spans yet.
 */
export type TraceStartPayload = Omit<TracePayload, "endedAt" | "status" | "spans" | "output">;

export interface IngestRequest {
  schemaVersion: 1;
  trace: TracePayload | TraceStartPayload;
}

export interface IngestResponse {
  ok: true;
  traceId: string;
  projectId: string;
  spanCount: number;
  duplicate: boolean;
  /** True when the trace was stored without `endedAt` and waits for its end request. */
  running: boolean;
  requestId: string;
}

// ---------------------------------------------------------------------------
// Streaming a trace: POST /api/v1/traces/{traceId}/spans and .../end

export interface SpansRequest {
  schemaVersion: 1;
  spans: SpanPayload[];
}

export interface SpansResponse {
  ok: true;
  traceId: string;
  /** Spans written by this request. */
  added: number;
  /** Spans already stored with identical content. */
  duplicate: number;
  /** Spans on the trace after this request. */
  spanCount: number;
  requestId: string;
}

export interface EndTraceRequest {
  schemaVersion: 1;
  endedAt: string;
  status?: TraceStatus;
  provider?: string;
  model?: string;
  output?: JsonValue;
  usage?: Usage;
  costUsd?: number;
  /** Shallow-merged into the metadata sent at the start. */
  metadata?: JsonObject;
  /** Added to the tags sent at the start. */
  tags?: string[];
  /** The last finished spans, saving a round trip. */
  spans?: SpanPayload[];
}

export interface EndTraceResponse {
  ok: true;
  traceId: string;
  /** True when the trace had already ended with this exact body; nothing written. */
  duplicate: boolean;
  spanCount: number;
  requestId: string;
}

export interface IngestErrorBody {
  error: { code: string; message: string; requestId?: string };
}

// ---------------------------------------------------------------------------
// Scores (POST /api/v1/traces/{traceId}/scores)

export type ScoreDataType = "numeric" | "categorical" | "boolean";
export type ScoreSource = "api" | "annotation" | "eval";
export type ScoreValue = number | string | boolean;

/** A judgement attached to a trace after the run: a rating, a verdict, an eval result. */
export interface ScoreInput {
  /** Letters, digits, '_' and '-', at most 64 characters. Doubles as the display name. */
  name: string;
  dataType: ScoreDataType;
  /** A number for numeric, a string (at most 200 characters) for categorical, a boolean for boolean. */
  value: ScoreValue;
  /** Why the score was given; at most 2000 characters. */
  comment?: string;
  /** 16-hex span id when the score applies to one span rather than the whole trace. */
  spanId?: string;
}
