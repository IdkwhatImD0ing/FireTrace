import { Timestamp, type DocumentData, type Firestore } from "firebase-admin/firestore";
import { iso, str } from "@/lib/firetrace/convert";
import { ApiError } from "@/lib/firetrace/errors";
import { isEvaluatorId, newEvaluatorId } from "@/lib/firetrace/ids";
import { outputTypeSchema, type EvalRun, type Evaluator, type EvaluatorInput } from "./schema";

/**
 * Firestore access for evaluator definitions (`projects/{id}/evaluators`) and
 * their run log (`projects/{id}/evalRuns`). Both are owner-only and are
 * deleted only with their project.
 */

export const EVALUATORS_COLLECTION = "evaluators";
export const EVAL_RUNS_COLLECTION = "evalRuns";

export function toEvaluator(id: string, d: DocumentData): Evaluator {
  const outputType = outputTypeSchema.safeParse(d.outputType);
  return {
    id,
    name: str(d.name) ?? "(unnamed)",
    description: str(d.description) ?? "",
    promptTemplate: str(d.promptTemplate) ?? "",
    outputType: outputType.success ? outputType.data : { kind: "boolean" },
    model: str(d.model),
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function toEvalRun(id: string, d: DocumentData): EvalRun {
  const usage = d.usage && typeof d.usage === "object" ? (d.usage as EvalRun["usage"]) : null;
  const status = d.status === "ok" || d.status === "failed" ? d.status : "running";
  return {
    id,
    evaluatorId: str(d.evaluatorId) ?? "",
    evaluatorName: str(d.evaluatorName) ?? "",
    traceId: str(d.traceId) ?? "",
    trigger: d.trigger === "bulk" ? "bulk" : "manual",
    status,
    model: str(d.model),
    usage,
    durationMs: typeof d.durationMs === "number" ? d.durationMs : null,
    error: str(d.error),
    scoreId: str(d.scoreId),
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
  };
}

function evaluators(db: Firestore, projectId: string) {
  return db.collection("projects").doc(projectId).collection(EVALUATORS_COLLECTION);
}

function evaluatorDocument(input: EvaluatorInput) {
  return {
    name: input.name,
    description: input.description,
    promptTemplate: input.promptTemplate,
    outputType: input.outputType,
    model: input.model ?? null,
  };
}

export async function createEvaluator(
  db: Firestore,
  projectId: string,
  input: EvaluatorInput,
): Promise<Evaluator> {
  const ref = evaluators(db, projectId).doc(newEvaluatorId());
  const now = Timestamp.now();
  const doc = { ...evaluatorDocument(input), createdAt: now, updatedAt: now };
  await ref.create(doc);
  return toEvaluator(ref.id, doc);
}

export async function updateEvaluator(
  db: Firestore,
  projectId: string,
  evaluatorId: string,
  input: EvaluatorInput,
): Promise<Evaluator> {
  if (!isEvaluatorId(evaluatorId)) throw new ApiError(404, "not_found", "Evaluator not found.");
  const ref = evaluators(db, projectId).doc(evaluatorId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ApiError(404, "not_found", "Evaluator not found.");
    const now = Timestamp.now();
    tx.update(ref, { ...evaluatorDocument(input), updatedAt: now });
    return toEvaluator(ref.id, {
      ...snap.data(),
      ...evaluatorDocument(input),
      updatedAt: now,
    });
  });
}

/** Removes the definition only; its runs and the scores it wrote stay as history. */
export async function deleteEvaluator(
  db: Firestore,
  projectId: string,
  evaluatorId: string,
): Promise<void> {
  if (!isEvaluatorId(evaluatorId)) throw new ApiError(404, "not_found", "Evaluator not found.");
  const ref = evaluators(db, projectId).doc(evaluatorId);
  if (!(await ref.get()).exists) throw new ApiError(404, "not_found", "Evaluator not found.");
  await ref.delete();
}

export async function getEvaluator(
  db: Firestore,
  projectId: string,
  evaluatorId: string,
): Promise<Evaluator | null> {
  if (!isEvaluatorId(evaluatorId)) return null;
  const snap = await evaluators(db, projectId).doc(evaluatorId).get();
  return snap.exists ? toEvaluator(snap.id, snap.data() ?? {}) : null;
}

export async function requireEvaluator(
  db: Firestore,
  projectId: string,
  evaluatorId: string,
): Promise<Evaluator> {
  const evaluator = await getEvaluator(db, projectId, evaluatorId);
  if (!evaluator) throw new ApiError(404, "not_found", "Evaluator not found.");
  return evaluator;
}

export async function listEvaluators(db: Firestore, projectId: string): Promise<Evaluator[]> {
  const snap = await evaluators(db, projectId).orderBy("name").get();
  return snap.docs.map((d) => toEvaluator(d.id, d.data()));
}

/** Newest runs first, optionally for one evaluator. */
export async function listEvalRuns(
  db: Firestore,
  projectId: string,
  options: { evaluatorId?: string; limit?: number } = {},
): Promise<EvalRun[]> {
  let q: FirebaseFirestore.Query = db
    .collection("projects")
    .doc(projectId)
    .collection(EVAL_RUNS_COLLECTION);
  if (options.evaluatorId) q = q.where("evaluatorId", "==", options.evaluatorId);
  const snap = await q
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
    .get();
  return snap.docs.map((d) => toEvalRun(d.id, d.data()));
}

/** Bookkeeping helpers for run documents; `run.ts` owns the sequence. */
export function evalRunRef(db: Firestore, projectId: string, runId: string) {
  return db.collection("projects").doc(projectId).collection(EVAL_RUNS_COLLECTION).doc(runId);
}
