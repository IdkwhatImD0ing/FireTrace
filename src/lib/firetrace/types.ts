import type { JsonObject, JsonValue, SpanKind, TraceStatus, Usage } from "./schema";
import type { KeyScope } from "./scopes";

/** Dashboard-facing models (Timestamps converted to ISO strings for serialization). */

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  ownerUid: string;
  createdAt: string;
  updatedAt: string;
  lastTraceAt: string | null;
  traceCount: number;
  spanCount: number;
  estimatedBytes: number;
  settings: { captureContent: boolean };
}

export interface ApiKeySummary {
  id: string;
  projectId: string;
  label: string;
  lastFour: string;
  createdAt: string;
  createdByUid: string;
  revokedAt: string | null;
  scopes: KeyScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface TraceSummary {
  id: string;
  name: string;
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  userId: string | null;
  tags: string[];
  usage: Usage;
  costUsd: number | null;
  spanCount: number;
  errorCount: number;
  estimatedBytes: number;
  ingestedAt: string | null;
}

export interface TraceDetail extends TraceSummary {
  schemaVersion: 1;
  bodyHash: string;
  input: JsonValue | null;
  output: JsonValue | null;
  metadata: JsonObject;
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes: JsonObject | null;
}

export interface SpanDetail {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  status: TraceStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider: string | null;
  model: string | null;
  input: JsonValue | null;
  output: JsonValue | null;
  attributes: JsonObject;
  events: SpanEvent[];
  usage: Usage | null;
  costUsd: number | null;
}

export interface TraceFilters {
  status?: TraceStatus;
  model?: string;
  sessionId?: string;
  userId?: string;
  /** ISO timestamps (inclusive). */
  from?: string;
  to?: string;
}

export interface TracePage {
  traces: TraceSummary[];
  nextCursor: string | null;
  prevCursor: string | null;
  pageSize: number;
}
