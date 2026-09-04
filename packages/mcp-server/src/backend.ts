/**
 * The storage-agnostic contract the MCP tools are built on. The dashboard
 * implements it directly on Firestore (remote MCP endpoint); the stdio CLI
 * implements it over the REST API. Shapes mirror the REST responses.
 */

export type KeyScope = "traces:write" | "traces:read" | "traces:delete";

export interface ListTracesQuery {
  status?: string;
  model?: string;
  sessionId?: string;
  userId?: string;
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
