/**
 * Wire format for POST /api/v1/traces (schemaVersion 1). Mirrors
 * src/lib/firetrace/schema.ts in the FireTrace app; keep the two in sync.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TraceStatus = "ok" | "error" | "unset";

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

export interface IngestRequest {
  schemaVersion: 1;
  trace: TracePayload;
}

export interface IngestResponse {
  ok: true;
  traceId: string;
  projectId: string;
  spanCount: number;
  duplicate: boolean;
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
