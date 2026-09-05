import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type {
  JsonObject,
  JsonValue,
  ScoreDataType,
  ScoreSource,
  SpanKind,
  TraceStatus,
  Usage,
} from "./schema";
import { SCORE_DATA_TYPES, SCORE_SOURCES, SPAN_KINDS, STATUSES } from "./schema";
import { scopesFromDocument } from "./scopes";
import type {
  ApiKeySummary,
  Project,
  Score,
  ScoreSummary,
  ScoreValue,
  SpanDetail,
  SpanEvent,
  TraceDetail,
  TraceSummary,
} from "./types";

/** Firestore document -> plain, serializable dashboard models. Defensive on shape. */

export function iso(v: unknown): string | null {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function enumOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function obj(v: unknown): JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

function usage(v: unknown): Usage {
  const o = obj(v);
  const out: Usage = {};
  if (typeof o.inputTokens === "number") out.inputTokens = o.inputTokens;
  if (typeof o.outputTokens === "number") out.outputTokens = o.outputTokens;
  if (typeof o.totalTokens === "number") out.totalTokens = o.totalTokens;
  return out;
}

function scoreValue(v: unknown): ScoreValue | null {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : null;
}

function scoreDataType(v: unknown, value: ScoreValue): ScoreDataType {
  const fallback: ScoreDataType =
    typeof value === "string" ? "categorical" : typeof value === "boolean" ? "boolean" : "numeric";
  return enumOf<ScoreDataType>(v, SCORE_DATA_TYPES, fallback);
}

function scoreSummaries(v: unknown): Record<string, ScoreSummary> {
  const out: Record<string, ScoreSummary> = {};
  for (const [name, raw] of Object.entries(obj(v))) {
    const s = obj(raw);
    const value = scoreValue(s.value);
    const scoreId = str(s.scoreId);
    if (value === null || !scoreId) continue;
    out[name] = {
      scoreId,
      dataType: scoreDataType(s.dataType, value),
      value,
      evaluatorId: str(s.evaluatorId),
    };
  }
  return out;
}

export function toScore(id: string, d: DocumentData): Score {
  const value = scoreValue(d.value) ?? 0;
  return {
    id,
    traceId: str(d.traceId) ?? "",
    spanId: str(d.spanId),
    name: str(d.name) ?? "(unnamed)",
    dataType: scoreDataType(d.dataType, value),
    value,
    comment: str(d.comment),
    source: enumOf<ScoreSource>(d.source, SCORE_SOURCES, "api"),
    evaluatorId: str(d.evaluatorId),
    runId: str(d.runId),
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
  };
}

export function toProject(id: string, d: DocumentData): Project {
  const settings = obj(d.settings);
  return {
    id,
    name: str(d.name) ?? "(unnamed)",
    slug: str(d.slug) ?? id,
    description: str(d.description) ?? "",
    ownerUid: str(d.ownerUid) ?? "",
    ownerEmail: str(d.ownerEmail),
    plan: d.plan === "trial" ? "trial" : "owner",
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
    lastTraceAt: iso(d.lastTraceAt),
    traceCount: num(d.traceCount),
    spanCount: num(d.spanCount),
    estimatedBytes: num(d.estimatedBytes),
    settings: { captureContent: settings.captureContent !== false },
  };
}

export function toApiKeySummary(id: string, d: DocumentData): ApiKeySummary {
  return {
    id,
    projectId: str(d.projectId) ?? "",
    label: str(d.label) ?? "(unlabeled)",
    lastFour: str(d.lastFour) ?? "????",
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    createdByUid: str(d.createdByUid) ?? "",
    revokedAt: iso(d.revokedAt),
    scopes: scopesFromDocument(d.scopes),
    expiresAt: iso(d.expiresAt),
    lastUsedAt: iso(d.lastUsedAt),
  };
}

export function toTraceSummary(id: string, d: DocumentData): TraceSummary {
  return {
    id,
    name: str(d.name) ?? "(unnamed)",
    status: enumOf<TraceStatus>(d.status, STATUSES, "unset"),
    startedAt: iso(d.startedAt) ?? new Date(0).toISOString(),
    endedAt: iso(d.endedAt) ?? new Date(0).toISOString(),
    durationMs: num(d.durationMs),
    provider: str(d.provider),
    model: str(d.model),
    sessionId: str(d.sessionId),
    userId: str(d.userId),
    tags: Array.isArray(d.tags)
      ? d.tags.filter((t: unknown): t is string => typeof t === "string")
      : [],
    usage: usage(d.usage),
    costUsd: numOrNull(d.costUsd),
    spanCount: num(d.spanCount),
    errorCount: num(d.errorCount),
    estimatedBytes: num(d.estimatedBytes),
    ingestedAt: iso(d.ingestedAt),
    scores: scoreSummaries(d.scores),
  };
}

export function toTraceDetail(id: string, d: DocumentData): TraceDetail {
  return {
    ...toTraceSummary(id, d),
    schemaVersion: 1,
    bodyHash: str(d.bodyHash) ?? "",
    input: d.input === undefined ? null : (d.input as JsonValue),
    output: d.output === undefined ? null : (d.output as JsonValue),
    metadata: obj(d.metadata),
    metadataUpdatedAt: iso(d.metadataUpdatedAt),
  };
}

export function toSpanDetail(id: string, d: DocumentData): SpanDetail {
  const events: SpanEvent[] = Array.isArray(d.events)
    ? d.events.map((e: DocumentData) => ({
        name: str(e?.name) ?? "event",
        timestamp: iso(e?.timestamp) ?? new Date(0).toISOString(),
        attributes: e?.attributes ? obj(e.attributes) : null,
      }))
    : [];
  return {
    id,
    traceId: str(d.traceId) ?? "",
    parentSpanId: str(d.parentSpanId),
    name: str(d.name) ?? "(unnamed)",
    kind: enumOf<SpanKind>(d.kind, SPAN_KINDS, "custom"),
    status: enumOf<TraceStatus>(d.status, STATUSES, "unset"),
    startedAt: iso(d.startedAt) ?? new Date(0).toISOString(),
    endedAt: iso(d.endedAt) ?? new Date(0).toISOString(),
    durationMs: num(d.durationMs),
    provider: str(d.provider),
    model: str(d.model),
    input: d.input === undefined ? null : (d.input as JsonValue),
    output: d.output === undefined ? null : (d.output as JsonValue),
    attributes: obj(d.attributes),
    events,
    usage: d.usage ? usage(d.usage) : null,
    costUsd: numOrNull(d.costUsd),
  };
}
