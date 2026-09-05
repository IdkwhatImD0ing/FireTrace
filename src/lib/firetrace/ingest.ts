import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { ApiError, rethrowQuotaExhausted } from "./errors";
import type { NormalizedIngest, NormalizedSpan, NormalizedTrace } from "./normalize";
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
import { effectivePlan, TRIAL_USAGE_COLLECTION, trialLimitMessage, trialSubject } from "./trial";

export { authenticateApiKey, type AuthenticatedKey } from "./api-auth";

function toTimestamp(iso: string): Timestamp {
  return Timestamp.fromDate(new Date(iso));
}

/**
 * What the server stamps on a trace from the authenticating key. Neither
 * value is part of the body or its hash: the client cannot choose them, and a
 * resend with another key is still the same trace.
 */
export interface IngestStamp {
  /** The key's environment at ingest time; null = unassigned. Never rewritten. */
  environment: string | null;
  /** Which key sent the trace, so history can be assigned an environment per key later. */
  keyId: string | null;
}

const NO_STAMP: IngestStamp = { environment: null, keyId: null };

export function traceDocument(
  trace: NormalizedTrace,
  bodyHash: string,
  estimatedBytes: number,
  stamp: IngestStamp = NO_STAMP,
) {
  return {
    ...trace,
    startedAt: toTimestamp(trace.startedAt),
    endedAt: toTimestamp(trace.endedAt),
    bodyHash,
    estimatedBytes,
    environment: stamp.environment,
    keyId: stamp.keyId,
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
  /** Environment and key id copied onto the trace; omitted = unassigned (seed and test data). */
  stamp?: IngestStamp;
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
  const stamp = options.stamp ?? NO_STAMP;
  // Dashboard rollups for the trace's UTC day (all environments, and the
  // trace's own); read so the per-day key caps hold.
  const day = statsDayId(normalized.trace.startedAt);
  const dayRef = projectRef.collection(STATS_COLLECTION).doc(day);
  const envDayRef = projectRef
    .collection(STATS_ENV_COLLECTION)
    .doc(envStatsDocId(stamp.environment, day));

  try {
    return await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap, daySnap, envDaySnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(traceRef),
        tx.get(dayRef),
        tx.get(envDayRef),
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
        traceDocument(normalized.trace, normalized.bodyHash, normalized.estimatedBytes, stamp),
      );
      for (const span of normalized.spans) {
        tx.set(traceRef.collection("spans").doc(span.id), spanDocument(span));
      }
      const t = normalized.trace;
      const increments = (existing: StatsDayDoc) =>
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
              model: chooseKey(existing.byModel, t.model ?? null, STATS_CAPS.models),
              name: chooseKey(existing.byName, t.name, STATS_CAPS.names),
            },
          ),
          1,
        );
      tx.set(dayRef, increments(daySnap.data() ?? {}), { merge: true });
      tx.set(envDayRef, increments(envDaySnap.data() ?? {}), { merge: true });
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
