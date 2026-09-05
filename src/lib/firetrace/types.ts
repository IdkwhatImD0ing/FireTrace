import type {
  JsonObject,
  JsonValue,
  ScoreDataType,
  ScoreSource,
  SpanKind,
  TraceStatus,
  Usage,
} from "./schema";
import type { KeyScope } from "./scopes";

/** Dashboard-facing models (Timestamps converted to ISO strings for serialization). */

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  ownerUid: string;
  /** Email of the creator when known; shown to owners so trial projects are attributable. */
  ownerEmail: string | null;
  /** owner = unlimited; trial = created by a trial account and subject to FIRETRACE_TRIAL_TRACE_LIMIT. */
  plan: "owner" | "trial";
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
  /** Stamped onto every trace this key ingests; null = unassigned. */
  environment: string | null;
}

export interface TraceSummary {
  id: string;
  name: string;
  status: TraceStatus;
  /** Copied from the ingesting key at ingest time; null for unassigned and pre-environment traces. */
  environment: string | null;
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
  /** Latest score per name; the full history lives in projects/{id}/scores. */
  scores: Record<string, ScoreSummary>;
}

export interface TraceDetail extends TraceSummary {
  schemaVersion: 1;
  /** Hash of the body as ingested; PATCHing metadata deliberately leaves it alone. */
  bodyHash: string;
  input: JsonValue | null;
  output: JsonValue | null;
  metadata: JsonObject;
  /** Set the first time metadata was patched after ingestion; null if never. */
  metadataUpdatedAt: string | null;
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
  /** Exact trace name. */
  name?: string;
  /** One tag the trace must carry. */
  tag?: string;
  /** An environment slug, or `unassigned` for traces without one. Composes with every sort. */
  environment?: string;
  /** ISO timestamps (inclusive). */
  from?: string;
  to?: string;
}

/**
 * List orderings. `newest` combines with every filter; `slowest` and
 * `costliest` only with status, model, name, tag and environment (see queries.ts).
 */
export const TRACE_SORTS = ["newest", "slowest", "costliest"] as const;
export type TraceSort = (typeof TRACE_SORTS)[number];

/** Distinct values seen in recent traces, for filter suggestions. */
export interface TraceFacets {
  names: string[];
  models: string[];
  tags: string[];
}

export interface TracePage {
  traces: TraceSummary[];
  nextCursor: string | null;
  prevCursor: string | null;
  pageSize: number;
}

export type ScoreValue = number | string | boolean;

/** Denormalized onto the trace document: the newest score for one name. */
export interface ScoreSummary {
  scoreId: string;
  dataType: ScoreDataType;
  value: ScoreValue;
  evaluatorId: string | null;
}

export interface Score {
  id: string;
  traceId: string;
  spanId: string | null;
  name: string;
  dataType: ScoreDataType;
  value: ScoreValue;
  comment: string | null;
  source: ScoreSource;
  evaluatorId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface ScoreFilters {
  name?: string;
  /** Environment of the parent trace (slug or `unassigned`); resolved through the trace, never stored on the score. */
  environment?: string;
  /** ISO timestamps (inclusive). */
  from?: string;
  to?: string;
}

export interface ScorePage {
  scores: Score[];
  nextCursor: string | null;
  pageSize: number;
}
