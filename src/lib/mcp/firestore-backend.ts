import type { Firestore } from "firebase-admin/firestore";
import type {
  ListScoresQuery,
  ListTracesQuery,
  MetadataPatchResult,
  ProjectLike,
  RecordResult,
  ScoreInputLike,
  ScoreLike,
  ScorePageLike,
  TraceBackend,
  TraceDetailLike,
  TracePageLike,
} from "@firetrace/mcp";
import type { ServerEnv } from "@/lib/env/server";
import type { AuthenticatedKey } from "@/lib/firetrace/api-auth";
import { ApiError } from "@/lib/firetrace/errors";
import { ingestTrace } from "@/lib/firetrace/ingest";
import { normalizeMetadataPatch, patchTraceMetadata } from "@/lib/firetrace/metadata";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { ingestRequestJsonSchema } from "@/lib/firetrace/openapi";
import { deleteTrace, requireProject } from "@/lib/firetrace/projects";
import {
  DEFAULT_PAGE_SIZE,
  getTrace,
  listSpans,
  listTraces,
  MAX_PAGE_SIZE,
  parseTraceFilters,
  parseTraceSort,
} from "@/lib/firetrace/queries";
import {
  addScore,
  DEFAULT_SCORE_PAGE_SIZE,
  listScores,
  listScoresForTrace,
  MAX_SCORE_PAGE_SIZE,
  normalizeScoreInput,
  parseScoreFilters,
} from "@/lib/firetrace/scores";
import { storageLevel } from "@/lib/firetrace/storage";

/**
 * TraceBackend for the in-app MCP endpoint: talks to Firestore through the
 * Admin SDK with the same code paths as the REST routes, so scope checks,
 * validation, idempotency, and counters behave identically.
 */
export class FirestoreBackend implements TraceBackend {
  readonly scopes: readonly string[];
  readonly projectId: string;

  constructor(
    private readonly db: Firestore,
    private readonly env: ServerEnv,
    private readonly auth: AuthenticatedKey,
  ) {
    this.scopes = auth.scopes;
    this.projectId = auth.projectId;
  }

  async getProject(): Promise<ProjectLike> {
    const p = await requireProject(this.db, this.projectId);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      traceCount: p.traceCount,
      spanCount: p.spanCount,
      estimatedBytes: p.estimatedBytes,
      lastTraceAt: p.lastTraceAt,
      createdAt: p.createdAt,
      storage: {
        limitBytes: this.env.storageLimitBytes,
        level: storageLevel(p.estimatedBytes, this.env.storageLimitBytes),
      },
    };
  }

  async listTraces(query: ListTracesQuery): Promise<TracePageLike> {
    const filters = parseTraceFilters({
      status: query.status,
      model: query.model,
      name: query.name,
      tag: query.tag,
      sessionId: query.sessionId,
      userId: query.userId,
      from: query.from,
      to: query.to,
    });
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    return listTraces(this.db, this.projectId, filters, {
      after: query.cursor,
      limit,
      sort: parseTraceSort(query.sort),
    });
  }

  async getTrace(traceId: string): Promise<TraceDetailLike | null> {
    const trace = await getTrace(this.db, this.projectId, traceId);
    if (!trace) return null;
    const [spans, scores] = await Promise.all([
      listSpans(this.db, this.projectId, traceId),
      listScoresForTrace(this.db, this.projectId, traceId),
    ]);
    return { trace, spans, scores };
  }

  async addScore(traceId: string, input: ScoreInputLike): Promise<ScoreLike> {
    const normalized = normalizeScoreInput(input);
    if (!normalized.ok) {
      throw new ApiError(400, normalized.error.code, normalized.error.message);
    }
    return addScore(this.db, this.projectId, traceId, normalized.value, { source: "api" });
  }

  async listScores(query: ListScoresQuery): Promise<ScorePageLike> {
    if (query.traceId) {
      const scores = await listScoresForTrace(this.db, this.projectId, query.traceId);
      return {
        scores: query.name ? scores.filter((s) => s.name === query.name) : scores,
        nextCursor: null,
      };
    }
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_SCORE_PAGE_SIZE, 1),
      MAX_SCORE_PAGE_SIZE,
    );
    const page = await listScores(
      this.db,
      this.projectId,
      parseScoreFilters({ name: query.name }),
      {
        after: query.cursor,
        limit,
      },
    );
    return { scores: page.scores, nextCursor: page.nextCursor };
  }

  async recordTrace(body: unknown): Promise<RecordResult> {
    const normalized = normalizeIngestBody(body);
    if (!normalized.ok) {
      const status = normalized.error.code === "payload_too_large" ? 413 : 400;
      throw new ApiError(status, normalized.error.code, normalized.error.message);
    }
    const outcome = await ingestTrace(this.db, this.projectId, normalized.value, {
      trialTraceLimit: this.env.trialTraceLimit,
      repositoryUrl: this.env.repositoryUrl,
      allowedEmails: this.env.allowedEmails,
    });
    return {
      ok: true,
      traceId: normalized.value.trace.id,
      spanCount: normalized.value.spans.length,
      duplicate: outcome.duplicate,
    };
  }

  async patchTraceMetadata(
    traceId: string,
    metadata: Record<string, unknown>,
  ): Promise<MetadataPatchResult> {
    const normalized = normalizeMetadataPatch({ metadata });
    if (!normalized.ok) {
      throw new ApiError(400, normalized.error.code, normalized.error.message);
    }
    const outcome = await patchTraceMetadata(this.db, this.projectId, traceId, normalized.value);
    return { traceId, metadata: outcome.metadata, changed: outcome.changed };
  }

  async deleteTrace(traceId: string): Promise<void> {
    await deleteTrace(this.db, this.projectId, traceId);
  }

  async ingestSchema(): Promise<unknown> {
    return ingestRequestJsonSchema();
  }

  /** Exposed for logging. */
  get keyId(): string {
    return this.auth.keyId;
  }
}
