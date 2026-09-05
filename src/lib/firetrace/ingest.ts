import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { ApiError, rethrowQuotaExhausted } from "./errors";
import type { NormalizedIngest, NormalizedSpan, NormalizedTrace } from "./normalize";
import {
  chooseKey,
  STATS_CAPS,
  STATS_COLLECTION,
  statsDayId,
  statsIncrements,
  traceStatsDeltas,
} from "./stats-rollup";
import { effectivePlan, TRIAL_USAGE_COLLECTION, trialLimitMessage, trialSubject } from "./trial";

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

export interface IngestOptions {
  /** FIRETRACE_TRIAL_TRACE_LIMIT; 0 disables trial projects entirely. */
  trialTraceLimit: number;
  /** Linked from the limit-reached message. */
  repositoryUrl: string;
  /** DASHBOARD_ALLOWED_EMAILS: a trial project whose creator is now allowlisted is uncapped. */
  allowedEmails: readonly string[];
}

const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  trialTraceLimit: 0,
  repositoryUrl: "https://github.com/IdkwhatImD0ing/FireTrace",
  allowedEmails: [],
};

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
  options: IngestOptions = DEFAULT_INGEST_OPTIONS,
): Promise<IngestOutcome> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(normalized.trace.id);
  // Dashboard rollup for the trace's UTC day; read so the per-day key caps hold.
  const dayRef = projectRef
    .collection(STATS_COLLECTION)
    .doc(statsDayId(normalized.trace.startedAt));

  try {
    return await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap, daySnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(traceRef),
        tx.get(dayRef),
      ]);
      if (!projectSnap.exists) {
        throw new ApiError(
          401,
          "invalid_api_key",
          "The project for this API key no longer exists.",
        );
      }
      // Trial projects draw from a per-account counter that never decreases.
      // Read it before any write so the transaction stays valid.
      const ownerEmail =
        typeof projectSnap.get("ownerEmail") === "string"
          ? (projectSnap.get("ownerEmail") as string)
          : null;
      const trial =
        effectivePlan(
          { plan: projectSnap.get("plan") === "trial" ? "trial" : "owner", ownerEmail },
          options.allowedEmails,
        ) === "trial";
      const usageRef = trial
        ? db
            .collection(TRIAL_USAGE_COLLECTION)
            .doc(trialSubject(ownerEmail ?? String(projectSnap.get("ownerUid") ?? "")))
        : null;
      const usageSnap = usageRef ? await tx.get(usageRef) : null;

      if (traceSnap.exists) {
        if (traceSnap.get("bodyHash") === normalized.bodyHash) {
          return { created: false, duplicate: true } as const;
        }
        throw new ApiError(
          409,
          "trace_id_conflict",
          `Trace ${normalized.trace.id} already exists with different content. Traces are immutable; use a new trace id, or PATCH this one to merge into its metadata.`,
        );
      }
      if (usageRef) {
        const used = usageSnap?.get("tracesUsed");
        const tracesUsed = typeof used === "number" ? used : 0;
        if (tracesUsed >= options.trialTraceLimit) {
          throw new ApiError(
            403,
            "trial_limit_reached",
            trialLimitMessage(options.trialTraceLimit, options.repositoryUrl),
          );
        }
        tx.set(
          usageRef,
          {
            tracesUsed: FieldValue.increment(1),
            lastTraceAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      tx.set(
        traceRef,
        traceDocument(normalized.trace, normalized.bodyHash, normalized.estimatedBytes),
      );
      for (const span of normalized.spans) {
        tx.set(traceRef.collection("spans").doc(span.id), spanDocument(span));
      }
      const t = normalized.trace;
      const day = daySnap.data() ?? {};
      tx.set(
        dayRef,
        statsIncrements(
          traceStatsDeltas(
            {
              name: t.name,
              status: t.status,
              startedAt: t.startedAt,
              durationMs: t.durationMs,
              model: t.model ?? null,
              usage: t.usage,
              costUsd: t.costUsd ?? null,
              spanCount: t.spanCount,
            },
            {
              model: chooseKey(day.byModel, t.model ?? null, STATS_CAPS.models),
              name: chooseKey(day.byName, t.name, STATS_CAPS.names),
            },
          ),
          1,
        ),
        { merge: true },
      );
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
    rethrowQuotaExhausted(err);
  }
}
