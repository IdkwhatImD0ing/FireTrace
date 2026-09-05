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
  existingKey,
  scoreStatsDeltas,
  STATS_CAPS,
  STATS_COLLECTION,
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

/** Parse URL search params into validated filters; unknown values are ignored. */
export function parseScoreFilters(
  params: Record<string, string | string[] | undefined>,
): ScoreFilters {
  const first = (key: string) => trimmedParam(params, key, LIMITS.maxIdentifierLength);
  const name = first("name");
  return {
    name: name && scoreNameSchema.safeParse(name).success ? name : undefined,
    from: parseUtcDateParam(first("from")),
    to: parseUtcDateParam(first("to")),
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

/** Newest-first, cursor-paginated scores across the project. */
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

  if (page.after) {
    const after = decodeScoreCursor(page.after);
    if (!after) throw new ApiError(400, "invalid_request", "Invalid pagination cursor.");
    q = q.startAfter(after.createdAt, after.scoreId);
  }
  const snap = await q.limit(pageSize + 1).get();
  let docs = snap.docs;
  const hasMore = docs.length > pageSize;
  if (hasMore) docs = docs.slice(0, pageSize);
  const scores = docs.map((d) => toScore(d.id, d.data()));
  const last = scores[scores.length - 1];
  return {
    scores,
    pageSize,
    nextCursor: hasMore && last ? encodeScoreCursor(last.createdAt, last.id) : null,
  };
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
      const daySnap = dayRef ? await tx.get(dayRef) : null;
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
      if (dayRef && daySnap?.exists && isScoreValue(value)) {
        tx.set(
          dayRef,
          statsIncrements(scoreDeltas(daySnap.data() ?? {}, { name, value }, "remove"), -1),
          { merge: true },
        );
      }
    });
  } catch (err) {
    rethrowQuotaExhausted(err);
  }
}

function isScoreValue(v: unknown): v is number | string | boolean {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

/** Cascade for a trace deletion: remove every score of the trace and give its rollups back. */
export async function deleteScoresForTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
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
  const stats = db.collection("projects").doc(projectId).collection(STATS_COLLECTION);
  const daySnaps = days.length ? await db.getAll(...days.map((day) => stats.doc(day))) : [];
  for (const daySnap of daySnaps) {
    if (!daySnap.exists) continue;
    const data = daySnap.data() ?? {};
    const deltas = (byDay.get(daySnap.id) ?? []).flatMap((s) => scoreDeltas(data, s, "remove"));
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
