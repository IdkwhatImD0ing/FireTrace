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
