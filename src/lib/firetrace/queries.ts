import { FieldPath, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { toSpanDetail, toTraceDetail, toTraceSummary } from "./convert";
import { ApiError } from "./errors";
import { LIMITS, STATUSES, type TraceStatus } from "./schema";
import {
  TRACE_SORTS,
  type SpanDetail,
  type TraceDetail,
  type TraceFacets,
  type TraceFilters,
  type TracePage,
  type TraceSort,
  type TraceSummary,
} from "./types";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The document field each sort orders by (descending), with the trace id as tie-breaker. */
const SORT_FIELD: Record<TraceSort, string> = {
  newest: "startedAt",
  slowest: "durationMs",
  costliest: "costUsd",
};

/** Opaque cursor: base64url of [startedAt epoch ms, trace id]. */
export function encodeCursor(startedAt: string, traceId: string): string {
  return Buffer.from(JSON.stringify([Date.parse(startedAt), traceId]), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): { startedAt: Timestamp; traceId: string } | null {
  const decoded = decodeSortCursor(cursor, "newest");
  return decoded
    ? { startedAt: Timestamp.fromMillis(decoded.value), traceId: decoded.traceId }
    : null;
}

/**
 * Cursor for any sort: newest keeps the two-element form above (old bookmarks
 * stay valid); other sorts add the sort name so a cursor minted under one
 * ordering is refused under another.
 */
export function cursorFor(trace: TraceSummary, sort: TraceSort): string {
  if (sort === "newest") return encodeCursor(trace.startedAt, trace.id);
  const value = sort === "slowest" ? trace.durationMs : (trace.costUsd ?? 0);
  return Buffer.from(JSON.stringify([value, trace.id, sort]), "utf8").toString("base64url");
}

function decodeSortCursor(
  cursor: string,
  sort: TraceSort,
): { value: number; traceId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string") {
      return null;
    }
    if (!/^[0-9a-f]{32}$/.test(parsed[1]) || !Number.isFinite(parsed[0])) return null;
    const cursorSort = parsed.length > 2 ? parsed[2] : "newest";
    if (cursorSort !== sort) return null;
    return { value: parsed[0], traceId: parsed[1] };
  } catch {
    return null;
  }
}

/** Parse URL search params into validated filters; unknown values are ignored. */
export function parseTraceFilters(
  params: Record<string, string | string[] | undefined>,
): TraceFilters {
  const first = (key: string, max: number = LIMITS.maxIdentifierLength) => {
    const v = params[key];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim().slice(0, max) : undefined;
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
    name: first("name", LIMITS.maxNameLength),
    tag: first("tag", LIMITS.maxTagLength),
    from: from && !Number.isNaN(Date.parse(from)) ? new Date(from).toISOString() : undefined,
    to: to && !Number.isNaN(Date.parse(to)) ? new Date(to).toISOString() : undefined,
  };
}

/** The query string that reproduces a list view: filters plus a non-default sort, without cursors. */
export function traceListQuery(filters: TraceFilters, sort: TraceSort): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) search.set(k, v);
  if (sort !== "newest") search.set("sort", sort);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Unknown or missing values mean newest first. */
export function parseTraceSort(value: string | string[] | null | undefined): TraceSort {
  const v = Array.isArray(value) ? value[0] : value;
  return (TRACE_SORTS as readonly string[]).includes(v ?? "") ? (v as TraceSort) : "newest";
}

/**
 * Newest-first, cursor-paginated trace list, or slowest/costliest first with a
 * subset of the filters. Every supported combination has a composite index in
 * firestore.indexes.json; Firestore merges the per-filter indexes when several
 * equality filters are combined.
 */
export async function listTraces(
  db: Firestore,
  projectId: string,
  filters: TraceFilters,
  page: { after?: string; before?: string; limit?: number; sort?: TraceSort },
): Promise<TracePage> {
  const pageSize = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const sort = page.sort ?? "newest";
  if (sort !== "newest" && (filters.sessionId || filters.userId || filters.from || filters.to)) {
    throw new ApiError(
      400,
      "invalid_request",
      `sort=${sort} combines only with status, model, name and tag filters; drop sessionId, userId, from and to or use the default order.`,
    );
  }
  let q: Query = db.collection("projects").doc(projectId).collection("traces");
  if (filters.status) q = q.where("status", "==", filters.status);
  if (filters.model) q = q.where("model", "==", filters.model);
  if (filters.name) q = q.where("name", "==", filters.name);
  if (filters.tag) q = q.where("tags", "array-contains", filters.tag);
  if (filters.sessionId) q = q.where("sessionId", "==", filters.sessionId);
  if (filters.userId) q = q.where("userId", "==", filters.userId);
  if (filters.from) q = q.where("startedAt", ">=", Timestamp.fromDate(new Date(filters.from)));
  if (filters.to) q = q.where("startedAt", "<=", Timestamp.fromDate(new Date(filters.to)));
  q = q.orderBy(SORT_FIELD[sort], "desc").orderBy(FieldPath.documentId(), "desc");

  const position = (cursor: string) => {
    const decoded = decodeSortCursor(cursor, sort);
    if (!decoded) throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");
    return [
      sort === "newest" ? Timestamp.fromMillis(decoded.value) : decoded.value,
      decoded.traceId,
    ] as const;
  };
  const cursor = (trace: TraceSummary) => cursorFor(trace, sort);

  let docs;
  if (page.before) {
    // Previous page: the pageSize items that precede the cursor, in the same order.
    const [value, traceId] = position(page.before);
    const snap = await q
      .endBefore(value, traceId)
      .limitToLast(pageSize + 1)
      .get();
    docs = snap.docs;
    const hasMoreBefore = docs.length > pageSize;
    if (hasMoreBefore) docs = docs.slice(1);
    const traces = docs.map((d) => toTraceSummary(d.id, d.data()));
    return {
      traces,
      pageSize,
      prevCursor: hasMoreBefore && traces[0] ? cursor(traces[0]) : null,
      nextCursor: traces.length ? cursor(traces[traces.length - 1]) : null,
    };
  }

  if (page.after) {
    const [value, traceId] = position(page.after);
    q = q.startAfter(value, traceId);
  }
  const snap = await q.limit(pageSize + 1).get();
  docs = snap.docs;
  const hasMore = docs.length > pageSize;
  if (hasMore) docs = docs.slice(0, pageSize);
  const traces = docs.map((d) => toTraceSummary(d.id, d.data()));
  return {
    traces,
    pageSize,
    nextCursor: hasMore && traces.length ? cursor(traces[traces.length - 1]) : null,
    prevCursor: page.after && traces.length ? cursor(traces[0]) : null,
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

/** Distinct names, models and tags seen in the 200 newest traces, for the filter datalists. */
export async function recentFacets(db: Firestore, projectId: string): Promise<TraceFacets> {
  const snap = await db
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .orderBy("startedAt", "desc")
    .limit(200)
    .select("name", "model", "tags")
    .get();
  const names = new Set<string>();
  const models = new Set<string>();
  const tags = new Set<string>();
  for (const d of snap.docs) {
    const name = d.get("name");
    const model = d.get("model");
    if (typeof name === "string" && name) names.add(name);
    if (typeof model === "string" && model) models.add(model);
    const traceTags = d.get("tags");
    if (Array.isArray(traceTags)) {
      for (const tag of traceTags) if (typeof tag === "string" && tag) tags.add(tag);
    }
  }
  return { names: [...names].sort(), models: [...models].sort(), tags: [...tags].sort() };
}

/** Distinct models seen in recent traces. Kept for callers of the older shape. */
export async function recentModels(db: Firestore, projectId: string): Promise<string[]> {
  return (await recentFacets(db, projectId)).models;
}
