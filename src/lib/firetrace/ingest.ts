import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { ApiError, isQuotaExhausted } from "./errors";
import type { NormalizedIngest, NormalizedSpan, NormalizedTrace } from "./normalize";

export { authenticateApiKey, type AuthenticatedKey } from "./api-auth";

function toTimestamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

export function traceDocument(trace: NormalizedTrace, bodyHash: string, estimatedBytes: number) {
  return {
    ...trace,
    startedAt: toTimestamp(trace.startedAt),
    endedAt: toTimestamp(trace.endedAt),
    bodyHash,
    estimatedBytes,
    ingestedAt: FieldValue.serverTimestamp(),
  };
}

export function spanDocument(span: NormalizedSpan) {
  return {
    ...span,
    startedAt: toTimestamp(span.startedAt),
    endedAt: toTimestamp(span.endedAt),
    events: span.events.map((e) => ({ ...e, timestamp: toTimestamp(e.timestamp) })),
  };
}

export type IngestOutcome =
  { created: true; duplicate: false } | { created: false; duplicate: true };

/**
 * Idempotent, transactional insert of one immutable trace:
 *  - absent            -> write trace + spans + project counters (201)
 *  - present, same hash -> no-op, duplicate (200)
 *  - present, differs   -> 409 trace_id_conflict
 */
export async function ingestTrace(
  db: Firestore,
  projectId: string,
  normalized: NormalizedIngest,
): Promise<IngestOutcome> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(normalized.trace.id);

  try {
    return await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap] = await Promise.all([tx.get(projectRef), tx.get(traceRef)]);
      if (!projectSnap.exists) {
        throw new ApiError(
          401,
          "invalid_api_key",
          "The project for this API key no longer exists.",
        );
      }
      if (traceSnap.exists) {
        if (traceSnap.get("bodyHash") === normalized.bodyHash) {
          return { created: false, duplicate: true } as const;
        }
        throw new ApiError(
          409,
          "trace_id_conflict",
          `Trace ${normalized.trace.id} already exists with different content. Traces are immutable; use a new trace id.`,
        );
      }

      tx.set(
        traceRef,
        traceDocument(normalized.trace, normalized.bodyHash, normalized.estimatedBytes),
      );
      for (const span of normalized.spans) {
        tx.set(traceRef.collection("spans").doc(span.id), spanDocument(span));
      }
      const incomingStart = toTimestamp(normalized.trace.startedAt);
      const previousLast = projectSnap.get("lastTraceAt");
      const lastTraceAt =
        previousLast instanceof Timestamp && previousLast.toMillis() > incomingStart.toMillis()
          ? previousLast
          : incomingStart;
      tx.update(projectRef, {
        traceCount: FieldValue.increment(1),
        spanCount: FieldValue.increment(normalized.spans.length),
        estimatedBytes: FieldValue.increment(normalized.estimatedBytes),
        lastTraceAt,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { created: true, duplicate: false } as const;
    });
  } catch (err) {
    if (isQuotaExhausted(err)) {
      throw new ApiError(
        429,
        "quota_exhausted",
        "Firestore refused the write because a quota is exhausted. Existing data is preserved; free space or upgrade the Firebase plan.",
      );
    }
    throw err;
  }
}
