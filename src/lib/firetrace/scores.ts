import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";
import { parseUtcDateParam, trimmedParam } from "@/lib/search-params";
import { toScore } from "./convert";
import { environmentFromDocument, parseEnvironmentFilter, storedEnvironment } from "./environment";
import { ApiError, rethrowQuotaExhausted } from "./errors";
import { isScoreId, newScoreId } from "./ids";
import { byteLength } from "./normalize";
import {
  describeIssues,
  LIMITS,
  SCORE_LIMITS,
  scoreInputSchema,
  scoreNameSchema,
  type ScoreInput,
  type ScoreSource,
} from "./schema";
import {
  chooseKey,
  envStatsDocId,
  existingKey,
  scoreStatsDeltas,
  STATS_CAPS,
  STATS_COLLECTION,
  STATS_ENV_COLLECTION,
  statsDayId,
  statsIncrements,
  type Delta,
} from "./stats-rollup";
import type { Score, ScoreFilters, ScorePage, ScoreSummary } from "./types";

/**
 * Scores are judgements attached to a trace after the run: a thumbs rating,
 * a reviewer's verdict, an evaluator's result. They live in a project-level
 * collection, `projects/{projectId}/scores/{scoreId}`, so "every score named X
 * in a time range" and "every score of trace Y" are each one indexed query.
 *
 * The newest score per name is also copied onto the trace document as
 * `scores[name]`, which is what the trace list and the trace page read. Score
 * bytes are counted on both the trace and the project, so deleting a trace
 * gives the storage back without further bookkeeping.
 *
 * Scores are only ever deleted explicitly: with `deleteScore`, or when their
 * trace or project is deleted.
 */

export const SCORES_COLLECTION = "scores";
export const DEFAULT_SCORE_PAGE_SIZE = 50;
export const MAX_SCORE_PAGE_SIZE = 500;
/**
 * The environment filter is resolved through each score's trace (one read per
 * distinct trace), so one request examines at most this many scores before
 * returning what it found with a cursor to continue from.
 */
export const MAX_SCORE_SCAN = 1000;

/** Query parameters `GET /api/v1/scores` understands; anything else is a 400 there. */
export const SCORE_LIST_PARAMS = ["name", "environment", "from", "to", "limit", "after"] as const;

export type NormalizeScoreResult =
  | { ok: true; value: ScoreInput }
  | { ok: false; error: { code: "invalid_request"; message: string } };

/** Validate a parsed request body. Never throws. */
export function normalizeScoreInput(body: unknown): NormalizeScoreResult {
  const parsed = scoreInputSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_request", message: describeIssues(parsed.error) } };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Parse URL search params into validated filters. Lenient by default (the
 * dashboard drops an unknown value); `strict` makes an invalid value a 400 for the API.
 */
export function parseScoreFilters(
  params: Record<string, string | string[] | undefined>,
  options: { strict?: boolean } = {},
): ScoreFilters {
  const strict = options.strict === true;
  const first = (key: string) => trimmedParam(params, key, LIMITS.maxIdentifierLength);
  const name = first("name");
  const validName = name !== undefined && scoreNameSchema.safeParse(name).success;
  if (strict && name && !validName) {
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid name "${name}". Score names use letters, digits, '_' and '-' (at most ${SCORE_LIMITS.maxNameLength} characters).`,
    );
  }
  const time = (key: "from" | "to") => {
    const raw = first(key);
    const parsed = parseUtcDateParam(raw);
    if (strict && raw && !parsed) {
      throw new ApiError(
        400,
        "invalid_request",
        `Invalid ${key} "${raw}". Use an ISO 8601 timestamp, e.g. 2026-09-02T19:01:02Z.`,
      );
    }
    return parsed;
  };
  return {
    name: validName ? name : undefined,
    environment: parseEnvironmentFilter(first("environment"), { strict }),
    from: time("from"),
    to: time("to"),
  };
}

export interface AddScoreOptions {
  source: ScoreSource;
  evaluatorId?: string;
  runId?: string;
}

function scoresCollection(db: Firestore, projectId: string) {
  return db.collection("projects").doc(projectId).collection(SCORES_COLLECTION);
}

function summaryOf(scoreId: string, d: DocumentData): ScoreSummary {
  const score = toScore(scoreId, d);
  return {
    scoreId,
    dataType: score.dataType,
    value: score.value,
    evaluatorId: score.evaluatorId,
  };
}

function statsDayRef(db: Firestore, projectId: string, createdAt: Timestamp) {
  return db
    .collection("projects")
    .doc(projectId)
    .collection(STATS_COLLECTION)
    .doc(statsDayId(createdAt.toDate().toISOString()));
}

/** The per-environment twin of `statsDayRef`, for the environment of the score's trace. */
function envStatsDayRef(
  db: Firestore,
  projectId: string,
  environment: string | null,
  createdAt: Timestamp,
) {
  return db
    .collection("projects")
    .doc(projectId)
    .collection(STATS_ENV_COLLECTION)
    .doc(envStatsDocId(environment, statsDayId(createdAt.toDate().toISOString())));
}

function scoreLabel(value: unknown): string | null {
  return typeof value === "number" ? null : String(value);
}

/** Rollup deltas for one score against a day document's existing keys. */
function scoreDeltas(
  day: DocumentData,
  score: { name: string; value: number | string | boolean },
  mode: "add" | "remove",
): Delta[] {
  const scores = day.scores as Record<string, DocumentData> | undefined;
  const label = scoreLabel(score.value);
  const nameKey =
    mode === "add"
      ? chooseKey(scores, score.name, STATS_CAPS.scoreNames)
      : existingKey(scores, score.name);
  const values = scores?.[nameKey]?.values as Record<string, unknown> | undefined;
  const labelKey =
    label === null
      ? null
      : mode === "add"
        ? chooseKey(values, label, STATS_CAPS.scoreLabels)
        : existingKey(values, label);
  return scoreStatsDeltas(score, { name: nameKey, label: labelKey });
}

/**
 * Append one score to a trace in a transaction: the score document, the
 * trace's `scores[name]` summary, and the byte estimates on trace and project.
 */
export async function addScore(
  db: Firestore,
  projectId: string,
  traceId: string,
  input: ScoreInput,
  options: AddScoreOptions,
): Promise<Score> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);
  const scoreRef = scoresCollection(db, projectId).doc(newScoreId());
  const createdAt = Timestamp.now();
  const dayRef = statsDayRef(db, projectId, createdAt);

  try {
    return await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap, existing, daySnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(traceRef),
        tx.get(
          scoresCollection(db, projectId)
            .where("traceId", "==", traceId)
            .select()
            .limit(SCORE_LIMITS.maxPerTrace),
        ),
        tx.get(dayRef),
      ]);
      if (!projectSnap.exists) {
        throw new ApiError(
          401,
          "invalid_api_key",
          "The project for this API key no longer exists.",
        );
      }
      if (!traceSnap.exists) {
        throw new ApiError(404, "not_found", "No such trace in this project.");
      }
      if (existing.size >= SCORE_LIMITS.maxPerTrace) {
        throw new ApiError(
          409,
          "conflict",
          `This trace already has ${SCORE_LIMITS.maxPerTrace} scores, the maximum. Delete one before adding another.`,
        );
      }
      // Scores roll up under their trace's environment; read that day too before writing.
      const envDayRef = envStatsDayRef(
        db,
        projectId,
        environmentFromDocument(traceSnap.get("environment")),
        createdAt,
      );
      const envDaySnap = await tx.get(envDayRef);

      const doc = {
        traceId,
        spanId: input.spanId ?? null,
        name: input.name,
        dataType: input.dataType,
        value: input.value,
        comment: input.comment ?? null,
        source: options.source,
        evaluatorId: options.evaluatorId ?? null,
        runId: options.runId ?? null,
        createdAt,
      };
      const summary = summaryOf(scoreRef.id, doc);
      const estimatedBytes = byteLength(doc) + byteLength({ [input.name]: summary });

      tx.create(scoreRef, { ...doc, estimatedBytes });
      tx.update(traceRef, {
        // Score names never contain ".", so this addresses the map entry scores[name].
        [`scores.${input.name}`]: summary,
        estimatedBytes: FieldValue.increment(estimatedBytes),
      });
      tx.update(projectRef, {
        estimatedBytes: FieldValue.increment(estimatedBytes),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(dayRef, statsIncrements(scoreDeltas(daySnap.data() ?? {}, input, "add"), 1), {
        merge: true,
      });
      tx.set(envDayRef, statsIncrements(scoreDeltas(envDaySnap.data() ?? {}, input, "add"), 1), {
        merge: true,
      });
      return toScore(scoreRef.id, doc);
    });
  } catch (err) {
    return rethrowQuotaExhausted(err);
  }
}

/** Every score of one trace, newest first (capped by SCORE_LIMITS.maxPerTrace). */
export async function listScoresForTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
): Promise<Score[]> {
  const snap = await scoresCollection(db, projectId)
    .where("traceId", "==", traceId)
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc")
    .get();
  return snap.docs.map((d) => toScore(d.id, d.data()));
}

/** Opaque cursor: base64url of [createdAt epoch ms, score id]. */
export function encodeScoreCursor(createdAt: string, scoreId: string): string {
  return Buffer.from(JSON.stringify([Date.parse(createdAt), scoreId]), "utf8").toString(
    "base64url",
  );
}

export function decodeScoreCursor(
  cursor: string,
): { createdAt: Timestamp; scoreId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || typeof parsed[0] !== "number" || typeof parsed[1] !== "string") {
      return null;
    }
    if (!isScoreId(parsed[1]) || !Number.isFinite(parsed[0])) return null;
    return { createdAt: Timestamp.fromMillis(parsed[0]), scoreId: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * Keep the scores whose trace is in `environment` (null = unassigned). The
 * environment is read from the trace, never stored on the score, so the two
 * cannot disagree; a score whose trace is gone matches nothing.
 */
async function inEnvironment(
  db: Firestore,
  projectId: string,
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  environment: string | null,
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const traces = db.collection("projects").doc(projectId).collection("traces");
  const traceIds = [
    ...new Set(docs.map((d) => d.get("traceId")).filter((id) => typeof id === "string")),
  ] as string[];
  if (traceIds.length === 0) return [];
  const snaps = await db.getAll(...traceIds.map((id) => traces.doc(id)), {
    fieldMask: ["environment"],
  });
  const byTrace = new Map(
    snaps.map((s) => [s.id, s.exists ? environmentFromDocument(s.get("environment")) : undefined]),
  );
  return docs.filter((d) => {
    const env = byTrace.get(d.get("traceId"));
    return env !== undefined && env === environment;
  });
}

/**
 * Newest-first, cursor-paginated scores across the project. With an
 * environment filter, scores are scanned in order and kept when their trace
 * matches, up to MAX_SCORE_SCAN per call; the cursor then points at the last
 * score examined, so paging continues where the scan stopped.
 */
export async function listScores(
  db: Firestore,
  projectId: string,
  filters: ScoreFilters,
  page: { after?: string; limit?: number },
): Promise<ScorePage> {
  const pageSize = Math.min(
    Math.max(page.limit ?? DEFAULT_SCORE_PAGE_SIZE, 1),
    MAX_SCORE_PAGE_SIZE,
  );
  let q: Query = scoresCollection(db, projectId);
  if (filters.name) q = q.where("name", "==", filters.name);
  if (filters.from) q = q.where("createdAt", ">=", Timestamp.fromDate(new Date(filters.from)));
  if (filters.to) q = q.where("createdAt", "<=", Timestamp.fromDate(new Date(filters.to)));
  q = q.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");

  let cursor: { createdAt: Timestamp; scoreId: string } | null = null;
  if (page.after) {
    cursor = decodeScoreCursor(page.after);
    if (!cursor) throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");
  }
  const wanted =
    filters.environment === undefined ? undefined : storedEnvironment(filters.environment);

  const scores: Score[] = [];
  let scanned = 0;
  for (;;) {
    const batch = cursor ? q.startAfter(cursor.createdAt, cursor.scoreId) : q;
    const snap = await batch.limit(pageSize + 1).get();
    const more = snap.docs.length > pageSize;
    const chunk = more ? snap.docs.slice(0, pageSize) : snap.docs;
    const kept = wanted === undefined ? chunk : await inEnvironment(db, projectId, chunk, wanted);
    for (const d of kept) scores.push(toScore(d.id, d.data()));
    scanned += chunk.length;
    const last = chunk[chunk.length - 1];
    if (scores.length >= pageSize || !more || scanned >= MAX_SCORE_SCAN || !last) {
      let nextCursor: string | null = null;
      if (scores.length > pageSize) {
        scores.length = pageSize;
        const tail = scores[pageSize - 1];
        nextCursor = encodeScoreCursor(tail.createdAt, tail.id);
      } else if (more && last) {
        nextCursor = encodeScoreCursor(toScore(last.id, last.data()).createdAt, last.id);
      }
      return { scores, pageSize, nextCursor };
    }
    cursor = { createdAt: last.get("createdAt") as Timestamp, scoreId: last.id };
  }
}

/**
 * Delete one score. If it was the trace's newest score for its name, the next
 * newest takes its place in `scores[name]`; with none left the entry goes.
 */
export async function deleteScore(
  db: Firestore,
  projectId: string,
  traceId: string,
  scoreId: string,
): Promise<void> {
  if (!isScoreId(scoreId)) throw new ApiError(404, "not_found", "No such score on this trace.");
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);
  const scoreRef = scoresCollection(db, projectId).doc(scoreId);

  try {
    await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap, scoreSnap] = await Promise.all([
        tx.get(projectRef),
        tx.get(traceRef),
        tx.get(scoreRef),
      ]);
      if (!scoreSnap.exists || scoreSnap.get("traceId") !== traceId) {
        throw new ApiError(404, "not_found", "No such score on this trace.");
      }
      const name =
        typeof scoreSnap.get("name") === "string" ? (scoreSnap.get("name") as string) : "";
      const bytes =
        typeof scoreSnap.get("estimatedBytes") === "number"
          ? (scoreSnap.get("estimatedBytes") as number)
          : 0;
      const createdAt = scoreSnap.get("createdAt");
      const dayRef = createdAt instanceof Timestamp ? statsDayRef(db, projectId, createdAt) : null;
      // The environment lives on the trace; without the trace (deleted concurrently) that rollup is left alone.
      const envDayRef =
        createdAt instanceof Timestamp && traceSnap.exists
          ? envStatsDayRef(
              db,
              projectId,
              environmentFromDocument(traceSnap.get("environment")),
              createdAt,
            )
          : null;
      const [daySnap, envDaySnap] = await Promise.all([
        dayRef ? tx.get(dayRef) : null,
        envDayRef ? tx.get(envDayRef) : null,
      ]);
      const remaining = await tx.get(
        scoresCollection(db, projectId)
          .where("traceId", "==", traceId)
          .where("name", "==", name)
          .orderBy("createdAt", "desc")
          .orderBy(FieldPath.documentId(), "desc")
          .limit(2),
      );
      const successor = remaining.docs.find((d) => d.id !== scoreId) ?? null;

      tx.delete(scoreRef);
      if (traceSnap.exists) {
        const current = traceSnap.get(new FieldPath("scores", name)) as DocumentData | undefined;
        const update: Record<string, unknown> = {
          estimatedBytes: FieldValue.increment(-bytes),
        };
        if (current?.scoreId === scoreId) {
          update[`scores.${name}`] = successor
            ? summaryOf(successor.id, successor.data())
            : FieldValue.delete();
        }
        tx.update(traceRef, update);
      }
      if (projectSnap.exists) {
        tx.update(projectRef, {
          estimatedBytes: FieldValue.increment(-bytes),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      const value = scoreSnap.get("value");
      if (isScoreValue(value)) {
        for (const [ref, snap] of [
          [dayRef, daySnap],
          [envDayRef, envDaySnap],
        ] as const) {
          if (!ref || !snap?.exists) continue;
          tx.set(
            ref,
            statsIncrements(scoreDeltas(snap.data() ?? {}, { name, value }, "remove"), -1),
            { merge: true },
          );
        }
      }
    });
  } catch (err) {
    rethrowQuotaExhausted(err);
  }
}

function isScoreValue(v: unknown): v is number | string | boolean {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

/**
 * Cascade for a trace deletion: remove every score of the trace and give its
 * rollups back, in both the all-environments and the trace's environment days.
 */
export async function deleteScoresForTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
  environment: string | null,
): Promise<number> {
  const snap = await scoresCollection(db, projectId).where("traceId", "==", traceId).get();
  if (snap.empty) return 0;
  const byDay = new Map<string, Array<{ name: string; value: number | string | boolean }>>();
  for (const d of snap.docs) {
    const createdAt = d.get("createdAt");
    const name = d.get("name");
    const value = d.get("value");
    if (!(createdAt instanceof Timestamp) || typeof name !== "string" || !isScoreValue(value)) {
      continue;
    }
    const day = statsDayId(createdAt.toDate().toISOString());
    const scores = byDay.get(day);
    if (scores) scores.push({ name, value });
    else byDay.set(day, [{ name, value }]);
  }
  const batch = db.batch();
  for (const d of snap.docs) batch.delete(d.ref);
  const days = [...byDay.keys()];
  const projectRef = db.collection("projects").doc(projectId);
  const refs = days.flatMap((day) => [
    projectRef.collection(STATS_COLLECTION).doc(day),
    projectRef.collection(STATS_ENV_COLLECTION).doc(envStatsDocId(environment, day)),
  ]);
  const daySnaps = refs.length ? await db.getAll(...refs) : [];
  for (const daySnap of daySnaps) {
    if (!daySnap.exists) continue;
    const data = daySnap.data() ?? {};
    const day = daySnap.id.slice(daySnap.id.indexOf(":") + 1);
    const deltas = (byDay.get(day) ?? []).flatMap((s) => scoreDeltas(data, s, "remove"));
    batch.set(daySnap.ref, statsIncrements(deltas, -1), { merge: true });
  }
  await batch.commit();
  return snap.size;
}

export interface ScoreNameSummary {
  name: string;
  dataType: Score["dataType"];
  count: number;
  /** Mean of the numeric values, or null when there are none. */
  average: number | null;
  /** Label → count for categorical and boolean values, most common first. */
  values: Array<{ label: string; count: number }>;
}

/** Per-name summary of a list of scores (pure; the dashboard runs it over one page). */
export function summarizeScores(scores: Score[]): ScoreNameSummary[] {
  const byName = new Map<
    string,
    {
      dataType: Score["dataType"];
      count: number;
      numericCount: number;
      sum: number;
      values: Map<string, number>;
    }
  >();
  for (const s of scores) {
    const entry = byName.get(s.name) ?? {
      dataType: s.dataType,
      count: 0,
      numericCount: 0,
      sum: 0,
      values: new Map<string, number>(),
    };
    entry.count += 1;
    if (typeof s.value === "number") {
      entry.numericCount += 1;
      entry.sum += s.value;
    } else {
      const label = String(s.value);
      entry.values.set(label, (entry.values.get(label) ?? 0) + 1);
    }
    byName.set(s.name, entry);
  }
  return [...byName.entries()]
    .map(([name, e]) => ({
      name,
      dataType: e.dataType,
      count: e.count,
      average: e.numericCount ? e.sum / e.numericCount : null,
      values: [...e.values.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
