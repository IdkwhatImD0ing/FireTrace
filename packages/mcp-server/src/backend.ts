/**
 * The storage-agnostic contract the MCP tools are built on. The dashboard
 * implements it directly on Firestore (remote MCP endpoint); the stdio CLI
 * implements it over the REST API. Shapes mirror the REST responses.
 */

export type KeyScope = "traces:write" | "traces:read" | "traces:delete";

export interface ListTracesQuery {
  status?: string;
  model?: string;
  /** Exact trace name. */
  name?: string;
  /** One tag the trace must carry. */
  tag?: string;
  sessionId?: string;
  userId?: string;
  /** newest (default), slowest or costliest; the latter two only with status/model/name/tag. */
  sort?: "newest" | "slowest" | "costliest";
  /** Inclusive ISO-8601 lower bound on startedAt. */
  from?: string;
  /** Inclusive ISO-8601 upper bound on startedAt. */
  to?: string;
  limit?: number;
  /** nextCursor from a previous page. */
  cursor?: string;
}

export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TraceSummaryLike {
  id: string;
  name: string;
  status: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider?: string | null;
  model?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  tags?: string[];
  usage?: UsageLike;
  costUsd?: number | null;
  spanCount: number;
  errorCount: number;
  /** Newest score per name. */
  scores?: Record<string, { value: number | string | boolean; dataType: string }>;
}

export interface TracePageLike {
  traces: TraceSummaryLike[];
  nextCursor: string | null;
  prevCursor?: string | null;
  pageSize?: number;
}

export interface SpanLike {
  id: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  provider?: string | null;
  model?: string | null;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: string; attributes?: unknown }>;
  usage?: UsageLike | null;
  costUsd?: number | null;
}

export interface TraceDetailLike {
  trace: TraceSummaryLike & { input?: unknown; output?: unknown; metadata?: unknown };
  spans: SpanLike[];
  /** Every score of the trace, newest first. */
  scores?: ScoreLike[];
}

/** A judgement attached to a trace after the run: a rating, a verdict, an eval result. */
export interface ScoreInputLike {
  /** Letters, digits, '_' and '-', at most 64 characters. */
  name: string;
  dataType: "numeric" | "categorical" | "boolean";
  /** A number for numeric, a string for categorical, a boolean for boolean. */
  value: number | string | boolean;
  comment?: string;
  spanId?: string;
}

export interface ScoreLike {
  id: string;
  traceId: string;
  spanId?: string | null;
  name: string;
  dataType: string;
  value: number | string | boolean;
  comment?: string | null;
  source: string;
  evaluatorId?: string | null;
  createdAt: string;
}

export interface ListScoresQuery {
  /** Only this trace's scores (its full history, newest first). */
  traceId?: string;
  /** Only scores with this name. */
  name?: string;
  limit?: number;
  /** nextCursor from a previous page. */
  cursor?: string;
}

export interface ScorePageLike {
  scores: ScoreLike[];
  nextCursor: string | null;
}

export interface ProjectLike {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  traceCount: number;
  spanCount: number;
  estimatedBytes: number;
  lastTraceAt: string | null;
  createdAt?: string;
  storage?: { limitBytes: number; level: string };
}

export interface RecordResult {
  ok: boolean;
  traceId: string;
  spanCount: number;
  duplicate: boolean;
}

export interface MetadataPatchResult {
  traceId: string;
  /** The full merged metadata. */
  metadata: Record<string, unknown>;
  /** False when the merge matched what was stored; nothing was written. */
  changed: boolean;
}

export interface TraceBackend {
  /** Scopes carried by the authenticated key; decides which tools are registered. */
  readonly scopes: readonly string[];
  readonly projectId: string;
  getProject(): Promise<ProjectLike>;
  listTraces(query: ListTracesQuery): Promise<TracePageLike>;
  /** Null when the trace does not exist in this project. */
  getTrace(traceId: string): Promise<TraceDetailLike | null>;
  /** Body in the ingestion format `{ schemaVersion: 1, trace }`. */
  recordTrace(body: unknown): Promise<RecordResult>;
  /**
   * Shallow-merge keys into a stored trace's metadata, the one mutable part of
   * a trace. Throws a BackendError with status 404 when it does not exist.
   */
  patchTraceMetadata(
    traceId: string,
    metadata: Record<string, unknown>,
  ): Promise<MetadataPatchResult>;
  /** Throws a BackendError with status 404 when the trace does not exist. */
  deleteTrace(traceId: string): Promise<void>;
  /** Attach a score to a stored trace. Throws a BackendError with status 404 when it does not exist. */
  addScore(traceId: string, input: ScoreInputLike): Promise<ScoreLike>;
  /** Scores of one trace, or across the project, newest first. */
  listScores(query: ListScoresQuery): Promise<ScorePageLike>;
  /** JSON Schema for the ingestion request body. */
  ingestSchema(): Promise<unknown>;
}

/** Error carrying an HTTP-style status and a stable code; tools render it verbatim. */
export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export function hasScope(backend: TraceBackend, scope: KeyScope): boolean {
  return backend.scopes.includes(scope);
}
