import { FieldPath, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { toSpanDetail, toTraceDetail, toTraceSummary } from "./convert";
import { ApiError } from "./errors";
import { STATUSES, type TraceStatus } from "./schema";
import type { SpanDetail, TraceDetail, TraceFilters, TracePage } from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Opaque cursor: base64url of [startedAt epoch ms, trace id]. */
export function encodeCursor(startedAt: string, traceId: string): string {
  return Buffer.from(JSON.stringify([Date.parse(startedAt), traceId]), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): { startedAt: Timestamp; traceId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string") {
      return null;
    }
    if (!/^[0-9a-f]{32}$/.test(parsed[1]) || !Number.isFinite(parsed[0])) return null;
    return { startedAt: Timestamp.fromMillis(parsed[0]), traceId: parsed[1] };
  } catch {
    return null;
  }
}

/** Parse URL search params into validated filters; unknown values are ignored. */
export function parseTraceFilters(
  params: Record<string, string | string[] | undefined>,
): TraceFilters {
  const first = (key: string) => {
    const v = params[key];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim().slice(0, 200) : undefined;
  };
  const status = first("status");
  // datetime-local values carry no zone; the UI labels them UTC, so treat them as UTC.
  const asUtc = (v: string | undefined) =>
    v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? `${v}Z` : v;
  const from = asUtc(first("from"));
  const to = asUtc(first("to"));
  return {
    status:
      status && (STATUSES as readonly string[]).includes(status)
        ? (status as TraceStatus)
        : undefined,
    model: first("model"),
    sessionId: first("sessionId"),
    userId: first("userId"),
    from: from && !Number.isNaN(Date.parse(from)) ? new Date(from).toISOString() : undefined,
    to: to && !Number.isNaN(Date.parse(to)) ? new Date(to).toISOString() : undefined,
  };
}

/**
 * Newest-first, cursor-paginated trace list. Equality filters each have a
 * composite index with startedAt (see firestore.indexes.json); Firestore
 * merges them when several are combined.
 */
export async function listTraces(
  db: Firestore,
  projectId: string,
  filters: TraceFilters,
  page: { after?: string; before?: string; limit?: number },
): Promise<TracePage> {
  const pageSize = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  let q: Query = db.collection("projects").doc(projectId).collection("traces");
  if (filters.status) q = q.where("status", "==", filters.status);
  if (filters.model) q = q.where("model", "==", filters.model);
  if (filters.sessionId) q = q.where("sessionId", "==", filters.sessionId);
  if (filters.userId) q = q.where("userId", "==", filters.userId);
  if (filters.from) q = q.where("startedAt", ">=", Timestamp.fromDate(new Date(filters.from)));
  if (filters.to) q = q.where("startedAt", "<=", Timestamp.fromDate(new Date(filters.to)));
  q = q.orderBy("startedAt", "desc").orderBy(FieldPath.documentId(), "desc");

  const after = page.after ? decodeCursor(page.after) : null;
  const before = page.before ? decodeCursor(page.before) : null;
  if (page.after && !after)
    throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");
  if (page.before && !before)
    throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");

  let docs;
  if (before) {
    // Previous page: the pageSize items that precede the cursor, still newest-first.
    const snap = await q
      .endBefore(before.startedAt, before.traceId)
      .limitToLast(pageSize + 1)
      .get();
    docs = snap.docs;
    const hasMoreBefore = docs.length > pageSize;
    if (hasMoreBefore) docs = docs.slice(1);
    const traces = docs.map((d) => toTraceSummary(d.id, d.data()));
    return {
      traces,
      pageSize,
      prevCursor:
        hasMoreBefore && traces[0] ? encodeCursor(traces[0].startedAt, traces[0].id) : null,
      nextCursor: traces.length
        ? encodeCursor(traces[traces.length - 1].startedAt, traces[traces.length - 1].id)
        : null,
    };
  }

  if (after) q = q.startAfter(after.startedAt, after.traceId);
  const snap = await q.limit(pageSize + 1).get();
  docs = snap.docs;
  const hasMore = docs.length > pageSize;
  if (hasMore) docs = docs.slice(0, pageSize);
  const traces = docs.map((d) => toTraceSummary(d.id, d.data()));
  return {
    traces,
    pageSize,
    nextCursor:
      hasMore && traces.length
        ? encodeCursor(traces[traces.length - 1].startedAt, traces[traces.length - 1].id)
        : null,
    prevCursor: after && traces.length ? encodeCursor(traces[0].startedAt, traces[0].id) : null,
  };
}

export async function getTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
): Promise<TraceDetail | null> {
  if (!/^[0-9a-f]{32}$/.test(traceId)) return null;
  const snap = await db
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .doc(traceId)
    .get();
  return snap.exists ? toTraceDetail(snap.id, snap.data() ?? {}) : null;
}

export async function listSpans(
  db: Firestore,
  projectId: string,
  traceId: string,
): Promise<SpanDetail[]> {
  const snap = await db
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .doc(traceId)
    .collection("spans")
    .orderBy("startedAt", "asc")
    .get();
  return snap.docs.map((d) => toSpanDetail(d.id, d.data()));
}

/** Distinct models seen in recent traces, for the filter dropdown. */
export async function recentModels(db: Firestore, projectId: string): Promise<string[]> {
  const snap = await db
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .orderBy("startedAt", "desc")
    .limit(200)
    .select("model")
    .get();
  const models = new Set<string>();
  for (const d of snap.docs) {
    const m = d.get("model");
    if (typeof m === "string" && m) models.add(m);
  }
  return [...models].sort();
}
