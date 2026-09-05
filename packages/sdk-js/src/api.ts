import { FireTraceError } from "./errors.js";
import type {
  JsonObject,
  JsonValue,
  ScoreDataType,
  ScoreInput,
  ScoreSource,
  ScoreValue,
  SpanKind,
  TraceStatus,
  Usage,
} from "./types.js";

/**
 * Read/delete client for the key-authenticated REST API (docs/api.md).
 * Separate from the ingestion client so an app that only records traces
 * never links the read surface.
 */
export interface FireTraceApiOptions {
  /** Deployment origin, e.g. https://tracing.art3m1s.me (the /api/v1/traces suffix is tolerated). */
  endpoint: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface KeyInfo {
  keyId: string;
  projectId: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** Stamped onto every trace this key records; null = unassigned. */
  environment: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  traceCount: number;
  spanCount: number;
  estimatedBytes: number;
  lastTraceAt: string | null;
  createdAt: string;
  storage: { limitBytes: number; level: "ok" | "warning" | "critical" };
  keyScopes: string[];
}

export interface TraceSummary {
  id: string;
  name: string;
  status: TraceStatus;
  /** Copied from the recording key at ingest; null = unassigned. */
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
  /** Newest score per name; `listTraceScores` returns the full history. */
  scores: Record<string, ScoreSummary>;
}

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

export interface ScorePage {
  scores: Score[];
  nextCursor: string | null;
  pageSize: number;
}

export interface ListScoresQuery {
  /** Exact score name. */
  name?: string;
  /** Environment of the score's trace (a slug or "unassigned"), resolved through the trace. */
  environment?: string;
  /** Inclusive ISO-8601 lower bound on createdAt. */
  from?: string;
  /** Inclusive ISO-8601 upper bound on createdAt. */
  to?: string;
  /** 1-500, default 50. */
  limit?: number;
  /** nextCursor of a previous page (older scores). */
  after?: string;
}

export interface TraceDetail extends TraceSummary {
  input?: JsonValue;
  output?: JsonValue;
  metadata: JsonObject;
  /** Set the first time metadata was patched after ingestion; null if never. */
  metadataUpdatedAt: string | null;
  /** Hash of the body as ingested. Patching metadata deliberately leaves it alone. */
  bodyHash: string;
}

export interface MetadataPatchResult {
  traceId: string;
  /** The full merged metadata, so a client that lost a race sees what won. */
  metadata: JsonObject;
  /** False when the merge matched what was stored; nothing was written. */
  changed: boolean;
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
  input?: JsonValue;
  output?: JsonValue;
  attributes: JsonObject;
  events: Array<{ name: string; timestamp: string; attributes: JsonObject | null }>;
  usage: Usage | null;
  costUsd: number | null;
}

export interface TracePage {
  traces: TraceSummary[];
  nextCursor: string | null;
  prevCursor: string | null;
  pageSize: number;
}

export interface ListTracesQuery {
  status?: TraceStatus;
  model?: string;
  /** Exact trace name. */
  name?: string;
  /** One tag the trace must carry. */
  tag?: string;
  /** An environment slug, or "unassigned" for traces recorded by keys without one. */
  environment?: string;
  sessionId?: string;
  userId?: string;
  /** newest (default), slowest or costliest; the latter two only with status/model/name/tag/environment. */
  sort?: "newest" | "slowest" | "costliest";
  /** Inclusive ISO-8601 lower bound on startedAt. */
  from?: string;
  /** Inclusive ISO-8601 upper bound on startedAt. */
  to?: string;
  /** 1-200, default 50. */
  limit?: number;
  /** nextCursor of a previous page (older traces). */
  after?: string;
  /** prevCursor of a previous page (newer traces). */
  before?: string;
}

export class FireTraceApi {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FireTraceApiOptions) {
    if (!options.endpoint)
      throw new FireTraceError("FireTrace: endpoint is required", { code: "config" });
    if (!options.apiKey)
      throw new FireTraceError("FireTrace: apiKey is required", { code: "config" });
    this.base = options.endpoint.replace(/\/+$/, "").replace(/\/api\/v1\/traces$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Describe the key itself (no scope needed). Useful to verify configuration at startup. */
  getKey(): Promise<KeyInfo> {
    return this.request<KeyInfo>("GET", "/api/v1/key");
  }

  /** The key's project with counters (scope traces:read). */
  getProject(): Promise<ProjectInfo> {
    return this.request<ProjectInfo>("GET", "/api/v1/project");
  }

  /** Newest-first page of traces (scope traces:read). */
  listTraces(query: ListTracesQuery = {}): Promise<TracePage> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    const qs = sp.toString();
    return this.request<TracePage>("GET", `/api/v1/traces${qs ? `?${qs}` : ""}`);
  }

  /** Iterate every matching trace across pages (scope traces:read). */
  async *iterateTraces(
    query: Omit<ListTracesQuery, "after" | "before"> = {},
  ): AsyncGenerator<TraceSummary> {
    let after: string | undefined;
    for (;;) {
      const page = await this.listTraces({ ...query, after });
      for (const t of page.traces) yield t;
      if (!page.nextCursor) return;
      after = page.nextCursor;
    }
  }

  /** One trace with all spans and scores, or null when it does not exist (scope traces:read). */
  async getTrace(
    traceId: string,
  ): Promise<{ trace: TraceDetail; spans: SpanDetail[]; scores: Score[] } | null> {
    try {
      return await this.request<{ trace: TraceDetail; spans: SpanDetail[]; scores: Score[] }>(
        "GET",
        `/api/v1/traces/${encodeURIComponent(traceId)}`,
      );
    } catch (err) {
      if (err instanceof FireTraceError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Attach a score to a stored trace (scope traces:write): a rating, a
   * reviewer's verdict, an eval result. Scores are append-only and indexed,
   * so unlike metadata they can be listed and filtered afterwards. Adding a
   * name again records a newer score; the trace's `scores` summary keeps the
   * newest per name.
   */
  async addScore(traceId: string, input: ScoreInput): Promise<Score> {
    const res = await this.request<{ score: Score }>(
      "POST",
      `/api/v1/traces/${encodeURIComponent(traceId)}/scores`,
      input,
    );
    return res.score;
  }

  /** Every score of one trace, newest first (scope traces:read). */
  async listTraceScores(traceId: string): Promise<Score[]> {
    const res = await this.request<{ scores: Score[] }>(
      "GET",
      `/api/v1/traces/${encodeURIComponent(traceId)}/scores`,
    );
    return res.scores;
  }

  /** Newest-first page of scores across the project (scope traces:read). */
  listScores(query: ListScoresQuery = {}): Promise<ScorePage> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    const qs = sp.toString();
    return this.request<ScorePage>("GET", `/api/v1/scores${qs ? `?${qs}` : ""}`);
  }

  /** Delete one score (scope traces:delete). */
  async deleteScore(traceId: string, scoreId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/v1/traces/${encodeURIComponent(traceId)}/scores/${encodeURIComponent(scoreId)}`,
    );
  }

  /**
   * Shallow-merge keys into a stored trace's metadata (scope traces:write).
   * The one mutable part of a trace: use it for judgements that only exist
   * after the run, such as a thumbs rating or a reviewer's verdict.
   *
   * A patched key replaces that top-level key outright, and concurrent writers
   * on the same key are last-writer-wins. Metadata is not indexed, so it
   * cannot be filtered or aggregated server-side.
   */
  patchMetadata(traceId: string, metadata: JsonObject): Promise<MetadataPatchResult> {
    return this.request<MetadataPatchResult>(
      "PATCH",
      `/api/v1/traces/${encodeURIComponent(traceId)}`,
      { metadata },
    );
  }

  /** Permanently delete one trace and its spans (scope traces:delete). */
  async deleteTrace(traceId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/traces/${encodeURIComponent(traceId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new FireTraceError(
        aborted
          ? `FireTrace request timed out after ${this.timeoutMs} ms`
          : "FireTrace network error",
        { code: aborted ? "timeout" : "network", retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const e = (
        parsed as { error?: { code?: string; message?: string; requestId?: string } } | null
      )?.error;
      throw new FireTraceError(
        e?.message ?? `FireTrace API request failed with HTTP ${res.status}`,
        {
          status: res.status,
          code: e?.code ?? `http_${res.status}`,
          requestId: e?.requestId ?? res.headers.get("x-request-id"),
          retryable: res.status === 429 || res.status >= 500,
        },
      );
    }
    return parsed as T;
  }
}
