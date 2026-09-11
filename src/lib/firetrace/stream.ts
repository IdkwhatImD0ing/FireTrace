import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { environmentFromDocument } from "./environment";
import { ApiError, rethrowQuotaExhausted } from "./errors";
import { spanDocument } from "./ingest";
import { firestoreSizeEstimate } from "./json-shape";
import {
  byteLength,
  spanHash,
  type NormalizedEnd,
  type NormalizedSpan,
  type NormalizedSpanBatch,
} from "./normalize";
import { LIMITS, type JsonObject } from "./schema";
import {
  chooseKey,
  envStatsDocId,
  STATS_CAPS,
  STATS_COLLECTION,
  STATS_ENV_COLLECTION,
  statsDayId,
  statsIncrements,
  traceStatsDeltas,
  type StatsDayDoc,
} from "./stats-rollup";
import { effectivePlan } from "./trial";

/**
 * The streaming half of ingestion. A trace posted without `endedAt`
 * (ingest.ts) is *running*: `appendSpans` adds finished spans to it and
 * `endTrace` closes it, once. Spans are as immutable here as in the
 * whole-trace form, and a resend of the same span or the same end body is a
 * duplicate rather than a conflict. Only the end request writes the
 * dashboard rollups, because only it knows the final duration and status.
 * Nothing here ever closes a trace on the server's own initiative.
 *
 * Two rules keep the rest of the model honest:
 *  - only a key in the trace's own environment may add to it or end it, so a
 *    preview key still cannot write production's numbers;
 *  - a trial trace may not grow past one whole-trace request, so the
 *    documented `limit × 2 MiB` per trial account still holds.
 *
 * Per-batch writes touch the trace document only; the project's span and
 * byte counters catch up at the end (or on delete) from the trace's
 * `unsettledSpans`/`unsettledBytes`, so many running traces never contend on
 * the one project document.
 */

export interface StreamCaller {
  /** The key's environment; null = unassigned. Must equal the trace's. */
  environment: string | null;
  /** DASHBOARD_ALLOWED_EMAILS, which decides whether the project is still a trial one. */
  allowedEmails: readonly string[];
}

/** The most a trial trace may hold in total: the size of one whole-trace request. */
export const TRIAL_TRACE_BYTES = LIMITS.maxRequestBytes;

export interface AppendOutcome {
  added: number;
  duplicate: number;
  spanCount: number;
}

export interface EndOutcome {
  duplicate: boolean;
  spanCount: number;
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function objectField(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function notFound(): ApiError {
  return new ApiError(404, "not_found", "No such trace in this project.");
}

function finished(traceId: string): ApiError {
  return new ApiError(
    409,
    "trace_finished",
    `Trace ${traceId} has already ended. Finished traces are immutable apart from metadata; start a new trace id.`,
  );
}

/** What appendSpans needs of a trace document that may hold 750 KiB of content. */
const APPEND_FIELDS = ["endedAt", "spanCount", "estimatedBytes", "environment"];

interface TraceRead {
  trace: DocumentSnapshot;
  spanSnaps: DocumentSnapshot[];
  trial: boolean;
}

/** Reads shared by both requests; every read happens here, before any write. */
async function readTrace(
  tx: Transaction,
  projectRef: DocumentReference,
  traceRef: DocumentReference,
  spans: NormalizedSpan[],
  caller: StreamCaller,
  traceFields?: string[],
): Promise<TraceRead> {
  const spansRef = traceRef.collection("spans");
  const spanRefs = spans.map((s) => spansRef.doc(s.id));
  const [projectSnap, traceSnaps, spanSnaps] = await Promise.all([
    tx.get(projectRef),
    tx.getAll(traceRef, ...(traceFields ? [{ fieldMask: traceFields }] : [])),
    spanRefs.length
      ? tx.getAll(...spanRefs, { fieldMask: ["bodyHash"] })
      : Promise.resolve([] as DocumentSnapshot[]),
  ]);
  const [trace] = traceSnaps;
  if (!projectSnap.exists) {
    throw new ApiError(401, "invalid_api_key", "The project for this API key no longer exists.");
  }
  if (!trace?.exists) throw notFound();
  if (environmentFromDocument(trace.get("environment")) !== caller.environment) {
    throw new ApiError(
      403,
      "forbidden",
      "This key belongs to a different environment than the trace. Only a key in the trace's environment can add spans to it or end it.",
    );
  }
  const ownerEmail =
    typeof projectSnap.get("ownerEmail") === "string"
      ? (projectSnap.get("ownerEmail") as string)
      : null;
  const trial =
    effectivePlan(
      { plan: projectSnap.get("plan") === "trial" ? "trial" : "owner", ownerEmail },
      caller.allowedEmails,
    ) === "trial";
  return { trace, spanSnaps, trial };
}

/**
 * Split a batch into spans to write and spans already stored with the same
 * content. A stored span with different content fails the whole batch, so a
 * retry can never half-apply.
 */
function classifySpans(
  traceId: string,
  spans: NormalizedSpan[],
  snaps: DocumentSnapshot[],
): { fresh: NormalizedSpan[]; duplicate: number } {
  const fresh: NormalizedSpan[] = [];
  let duplicate = 0;
  spans.forEach((span, i) => {
    const snap = snaps[i];
    if (!snap?.exists) {
      fresh.push(span);
    } else if (snap.get("bodyHash") === spanHash(span)) {
      duplicate++;
    } else {
      throw new ApiError(
        409,
        "span_conflict",
        `Span ${span.id} already exists in trace ${traceId} with different content. Spans are immutable; use a new span id.`,
      );
    }
  });
  return { fresh, duplicate };
}

function requireSpanRoom(stored: number, fresh: number): void {
  if (stored + fresh > LIMITS.maxSpans) {
    throw new ApiError(
      400,
      "invalid_trace",
      `The trace would have ${stored + fresh} spans; the limit is ${LIMITS.maxSpans} per trace.`,
    );
  }
}

function requireTrialRoom(trial: boolean, stored: number, added: number): void {
  if (trial && stored + added > TRIAL_TRACE_BYTES) {
    throw new ApiError(
      403,
      "trial_limit_reached",
      `A trial trace may hold at most ${TRIAL_TRACE_BYTES} bytes in total, the size of one whole-trace request. End this trace or start a new one.`,
    );
  }
}

/** Serialized size and error count of the spans about to be written. */
function spanTotals(fresh: NormalizedSpan[]): { bytes: number; errors: number } {
  let bytes = 0;
  let errors = 0;
  for (const span of fresh) {
    bytes += byteLength(span);
    if (span.status === "error") errors++;
  }
  return { bytes, errors };
}

function stageSpans(tx: Transaction, traceRef: DocumentReference, fresh: NormalizedSpan[]): void {
  for (const span of fresh) {
    tx.set(traceRef.collection("spans").doc(span.id), spanDocument(span));
  }
}

/** Append finished spans to a running trace. Idempotent per span. */
export async function appendSpans(
  db: Firestore,
  projectId: string,
  traceId: string,
  batch: NormalizedSpanBatch,
  caller: StreamCaller,
): Promise<AppendOutcome> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);
  try {
    return await db.runTransaction(async (tx) => {
      const { trace, spanSnaps, trial } = await readTrace(
        tx,
        projectRef,
        traceRef,
        batch.spans,
        caller,
        APPEND_FIELDS,
      );
      if (trace.get("endedAt") !== undefined) throw finished(traceId);
      const { fresh, duplicate } = classifySpans(traceId, batch.spans, spanSnaps);
      const stored = counter(trace.get("spanCount"));
      requireSpanRoom(stored, fresh.length);
      if (fresh.length > 0) {
        const totals = spanTotals(fresh);
        requireTrialRoom(trial, counter(trace.get("estimatedBytes")), totals.bytes);
        stageSpans(tx, traceRef, fresh);
        tx.update(traceRef, {
          spanCount: FieldValue.increment(fresh.length),
          errorCount: FieldValue.increment(totals.errors),
          estimatedBytes: FieldValue.increment(totals.bytes),
          unsettledSpans: FieldValue.increment(fresh.length),
          unsettledBytes: FieldValue.increment(totals.bytes),
        });
      }
      return { added: fresh.length, duplicate, spanCount: stored + fresh.length };
    });
  } catch (err) {
    rethrowQuotaExhausted(err);
  }
}

/**
 * Serialized-size difference the update makes to the trace document, key by
 * key, so `estimatedBytes` (which scores and metadata patches also add to)
 * moves by the change rather than being recomputed.
 */
function byteDelta(before: DocumentData, after: Record<string, unknown>): number {
  let delta = 0;
  for (const [key, value] of Object.entries(after)) {
    delta += byteLength({ [key]: value }) - byteLength({ [key]: before[key] });
  }
  return delta;
}

/**
 * Close a running trace: fill in the end-only fields, absorb the last span
 * batch, settle the project's counters, and roll the finished trace into the
 * day's dashboard stats. A repeat of the same end body is a duplicate; a
 * different one is a 409.
 */
export async function endTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
  end: NormalizedEnd,
  caller: StreamCaller,
): Promise<EndOutcome> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);
  try {
    return await db.runTransaction(async (tx) => {
      const { trace, spanSnaps, trial } = await readTrace(
        tx,
        projectRef,
        traceRef,
        end.spans,
        caller,
      );
      const d = trace.data() ?? {};
      if (d.endedAt !== undefined) {
        if (d.endHash === end.endHash) {
          return { duplicate: true, spanCount: counter(d.spanCount) };
        }
        throw finished(traceId);
      }
      if (!(d.startedAt instanceof Timestamp)) {
        throw new Error(`trace ${traceId} has no startedAt`);
      }
      const startedAt = d.startedAt.toDate().toISOString();
      const durationMs = Date.parse(end.endedAt) - Date.parse(startedAt);
      if (durationMs < 0) {
        throw new ApiError(400, "invalid_trace", "endedAt cannot precede the trace's startedAt");
      }
      const { fresh } = classifySpans(traceId, end.spans, spanSnaps);
      const stored = counter(d.spanCount);
      requireSpanRoom(stored, fresh.length);
      const totals = spanTotals(fresh);

      // The day's rollups, read after the trace so the day is known; still
      // before any write.
      const environment = environmentFromDocument(d.environment);
      const day = statsDayId(startedAt);
      const dayRef = projectRef.collection(STATS_COLLECTION).doc(day);
      const envDayRef = projectRef
        .collection(STATS_ENV_COLLECTION)
        .doc(envStatsDocId(environment, day));
      const [daySnap, envDaySnap] = await Promise.all([tx.get(dayRef), tx.get(envDayRef)]);

      const spanCount = stored + fresh.length;
      const errorCount = counter(d.errorCount) + totals.errors;
      const model = end.model ?? (typeof d.model === "string" ? d.model : null);
      const usage = end.usage ?? (d.usage && typeof d.usage === "object" ? d.usage : {});
      const costUsd = end.costUsd ?? (typeof d.costUsd === "number" ? d.costUsd : null);
      const name = typeof d.name === "string" ? d.name : "";

      // Plain values for the size checks; Firestore types are applied on write.
      const changes: Record<string, unknown> = {
        status: end.status,
        endedAt: end.endedAt,
        durationMs,
        spanCount,
        errorCount,
        endHash: end.endHash,
      };
      if (end.provider !== undefined) changes.provider = end.provider;
      if (end.model !== undefined) changes.model = end.model;
      if (end.output !== undefined) changes.output = end.output;
      if (end.usage !== undefined) changes.usage = end.usage;
      if (end.costUsd !== undefined) changes.costUsd = end.costUsd;
      if (end.metadata !== undefined)
        changes.metadata = { ...objectField(d.metadata), ...end.metadata };
      if (end.tags !== undefined) {
        changes.tags = [...new Set([...stringArray(d.tags), ...end.tags])].slice(0, LIMITS.maxTags);
      }
      const candidate = { ...d, ...changes };
      const bytes = Math.max(byteLength(candidate), firestoreSizeEstimate(candidate));
      if (bytes > LIMITS.maxDocumentBytes) {
        throw new ApiError(
          413,
          "payload_too_large",
          `The finished trace document would be about ${bytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes. Send less output or metadata.`,
        );
      }
      const delta = byteDelta(d, changes) + totals.bytes;
      requireTrialRoom(trial, counter(d.estimatedBytes), delta);

      stageSpans(tx, traceRef, fresh);
      tx.update(traceRef, {
        ...changes,
        endedAt: Timestamp.fromDate(new Date(end.endedAt)),
        estimatedBytes: FieldValue.increment(delta),
        unsettledSpans: FieldValue.delete(),
        unsettledBytes: FieldValue.delete(),
      });
      // Everything the batches added since the start, plus this request.
      tx.update(projectRef, {
        spanCount: FieldValue.increment(counter(d.unsettledSpans) + fresh.length),
        estimatedBytes: FieldValue.increment(counter(d.unsettledBytes) + delta),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const increments = (existing: StatsDayDoc) =>
        statsIncrements(
          traceStatsDeltas(
            { name, status: end.status, startedAt, durationMs, model, usage, costUsd, spanCount },
            {
              model: chooseKey(existing.byModel, model, STATS_CAPS.models),
              name: chooseKey(existing.byName, name, STATS_CAPS.names),
            },
          ),
          1,
        );
      tx.set(dayRef, increments(daySnap.data() ?? {}), { merge: true });
      tx.set(envDayRef, increments(envDaySnap.data() ?? {}), { merge: true });
      return { duplicate: false, spanCount };
    });
  } catch (err) {
    rethrowQuotaExhausted(err);
  }
}
