"use server";

import { revalidatePath } from "next/cache";
import { requireAccessibleProject } from "@/lib/auth/access";
import { requireOwner } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env/server";
import {
  createEvaluator,
  deleteEvaluator,
  requireEvaluator,
  updateEvaluator,
} from "@/lib/eval/evaluators";
import {
  previewEvaluator,
  runEvaluator,
  runEvaluatorBulk,
  type BulkOutcome,
  type PreviewOutcome,
  type RunOutcome,
} from "@/lib/eval/run";
import { EVAL_LIMITS, normalizeEvaluatorInput, type Evaluator } from "@/lib/eval/schema";
import { getEnvironmentView } from "@/lib/environment-selection";
import { adminDb } from "@/lib/firebase/admin";
import { normalizeEnvironment } from "@/lib/firetrace/environment";
import { ApiError } from "@/lib/firetrace/errors";
import { isTraceId } from "@/lib/firetrace/ids";
import { listTraces, parseTraceFilters } from "@/lib/firetrace/queries";
import {
  createApiKey,
  createProject,
  deleteProject,
  deleteTrace,
  revokeApiKey,
  rotateApiKey,
  setApiKeyEnvironment,
  updateProject,
} from "@/lib/firetrace/projects";
import { expiryFromPreset, normalizeScopes } from "@/lib/firetrace/scopes";
import { addScore, deleteScore, normalizeScoreInput } from "@/lib/firetrace/scores";
import { effectivePlan, TRIAL_MAX_KEYS } from "@/lib/firetrace/trial";
import type { ApiKeySummary, Score } from "@/lib/firetrace/types";
import { log } from "@/lib/log";

/**
 * Cookie-authenticated dashboard mutations. Next.js server actions verify the
 * request Origin against the Host before invoking these; every action then
 * re-verifies the session cookie and allowlist via requireOwner().
 */
export type ActionResult<T = undefined> =
  { ok: true; value: T } | { ok: false; error: string; code: string };

async function run<T>(name: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message, code: err.code };
    log("error", `action.${name}.failed`, { error: err });
    return {
      ok: false,
      error: "Something went wrong. Check the server logs.",
      code: "internal_error",
    };
  }
}

export async function createProjectAction(input: { name: string; description?: string }) {
  return run("createProject", async () => {
    const owner = await requireOwner();
    const project = await createProject(adminDb(), {
      ...input,
      ownerUid: owner.uid,
      ownerEmail: owner.email,
      plan: owner.role === "trial" ? "trial" : "owner",
    });
    revalidatePath("/projects");
    return { projectId: project.id };
  });
}

export async function updateProjectAction(
  projectId: string,
  input: { name: string; description?: string },
) {
  return run("updateProject", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    await updateProject(adminDb(), projectId, input);
    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}/settings`);
    return undefined;
  });
}

export async function deleteProjectAction(projectId: string, confirmName: string) {
  return run("deleteProject", async () => {
    const owner = await requireOwner();
    const db = adminDb();
    const project = await requireAccessibleProject(db, owner, projectId);
    if (confirmName.trim() !== project.name) {
      throw new ApiError(
        400,
        "invalid_request",
        "Type the project name exactly to confirm deletion.",
      );
    }
    const removed = await deleteProject(db, projectId);
    log("info", "project.deleted", { projectId, ...removed });
    revalidatePath("/projects");
    return removed;
  });
}

export async function createApiKeyAction(
  projectId: string,
  input: { label: string; scopes: string[]; expiry?: string; environment?: string | null },
): Promise<ActionResult<{ key: ApiKeySummary; plaintext: string }>> {
  return run("createApiKey", async () => {
    const owner = await requireOwner();
    const env = serverEnv();
    const project = await requireAccessibleProject(adminDb(), owner, projectId);
    const plan = effectivePlan(project, env.allowedEmails);
    const result = await createApiKey(adminDb(), {
      projectId,
      label: input.label,
      createdByUid: owner.uid,
      pepper: env.keyPepper,
      scopes: normalizeScopes(input.scopes),
      expiresAt: expiryFromPreset(input.expiry),
      environment: normalizeEnvironment(input.environment),
      plan,
      maxKeys: plan === "trial" ? TRIAL_MAX_KEYS : undefined,
    });
    revalidatePath(`/projects/${projectId}/settings`);
    revalidatePath(`/projects/${projectId}`);
    return result;
  });
}

/** Change the environment a key stamps from now on; traces it already sent keep theirs. */
export async function setApiKeyEnvironmentAction(
  projectId: string,
  keyId: string,
  environment: string | null,
): Promise<ActionResult<ApiKeySummary>> {
  return run("setApiKeyEnvironment", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    const key = await setApiKeyEnvironment(
      adminDb(),
      projectId,
      keyId,
      normalizeEnvironment(environment),
    );
    revalidatePath(`/projects/${projectId}/settings`);
    revalidatePath(`/projects/${projectId}`);
    return key;
  });
}

export async function revokeApiKeyAction(projectId: string, keyId: string) {
  return run("revokeApiKey", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    await revokeApiKey(adminDb(), projectId, keyId);
    revalidatePath(`/projects/${projectId}/settings`);
    return undefined;
  });
}

export async function rotateApiKeyAction(
  projectId: string,
  keyId: string,
): Promise<ActionResult<{ key: ApiKeySummary; plaintext: string }>> {
  return run("rotateApiKey", async () => {
    const owner = await requireOwner();
    const env = serverEnv();
    const project = await requireAccessibleProject(adminDb(), owner, projectId);
    const result = await rotateApiKey(adminDb(), {
      projectId,
      keyId,
      createdByUid: owner.uid,
      pepper: env.keyPepper,
      maxKeys: effectivePlan(project, env.allowedEmails) === "trial" ? TRIAL_MAX_KEYS : undefined,
    });
    revalidatePath(`/projects/${projectId}/settings`);
    return result;
  });
}

export async function deleteTraceAction(projectId: string, traceId: string) {
  return run("deleteTrace", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "Trace not found.");
    await deleteTrace(adminDb(), projectId, traceId);
    revalidatePath(`/projects/${projectId}`);
    return undefined;
  });
}

function revalidateScores(projectId: string, traceId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/scores`);
  revalidatePath(`/projects/${projectId}/traces/${traceId}`);
}

/** Annotate a trace from the dashboard. The body is validated like the API's. */
export async function addScoreAction(
  projectId: string,
  traceId: string,
  input: unknown,
): Promise<ActionResult<Score>> {
  return run("addScore", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "Trace not found.");
    const normalized = normalizeScoreInput(input);
    if (!normalized.ok) {
      throw new ApiError(400, normalized.error.code, normalized.error.message);
    }
    const score = await addScore(adminDb(), projectId, traceId, normalized.value, {
      source: "annotation",
    });
    revalidateScores(projectId, traceId);
    return score;
  });
}

export async function deleteScoreAction(projectId: string, traceId: string, scoreId: string) {
  return run("deleteScore", async () => {
    const owner = await requireOwner();
    await requireAccessibleProject(adminDb(), owner, projectId);
    if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "Trace not found.");
    await deleteScore(adminDb(), projectId, traceId, scoreId);
    revalidateScores(projectId, traceId);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Evaluators: owner-only, because running one spends the deployment's LLM key.

async function requireEvaluatorAccess(projectId: string) {
  const owner = await requireOwner();
  if (owner.role !== "owner") {
    throw new ApiError(403, "forbidden", "Evaluators are available to the deployment's owners.");
  }
  const db = adminDb();
  await requireAccessibleProject(db, owner, projectId);
  return db;
}

function requireEvalConfig() {
  const cfg = serverEnv().eval;
  if (!cfg) {
    throw new ApiError(
      500,
      "not_configured",
      "Set FIRETRACE_EVAL_BASE_URL, FIRETRACE_EVAL_API_KEY and FIRETRACE_EVAL_MODEL to run evaluators.",
    );
  }
  return cfg;
}

function parseEvaluator(input: unknown) {
  const normalized = normalizeEvaluatorInput(input);
  if (!normalized.ok) throw new ApiError(400, normalized.error.code, normalized.error.message);
  return normalized.value;
}

function revalidateEvaluators(projectId: string) {
  revalidatePath(`/projects/${projectId}/evaluators`);
}

export async function createEvaluatorAction(
  projectId: string,
  input: unknown,
): Promise<ActionResult<Evaluator>> {
  return run("createEvaluator", async () => {
    const db = await requireEvaluatorAccess(projectId);
    const evaluator = await createEvaluator(db, projectId, parseEvaluator(input));
    revalidateEvaluators(projectId);
    return evaluator;
  });
}

export async function updateEvaluatorAction(
  projectId: string,
  evaluatorId: string,
  input: unknown,
): Promise<ActionResult<Evaluator>> {
  return run("updateEvaluator", async () => {
    const db = await requireEvaluatorAccess(projectId);
    const evaluator = await updateEvaluator(db, projectId, evaluatorId, parseEvaluator(input));
    revalidateEvaluators(projectId);
    return evaluator;
  });
}

export async function deleteEvaluatorAction(projectId: string, evaluatorId: string) {
  return run("deleteEvaluator", async () => {
    const db = await requireEvaluatorAccess(projectId);
    await deleteEvaluator(db, projectId, evaluatorId);
    revalidateEvaluators(projectId);
    return undefined;
  });
}

/** Dry run of an unsaved definition against one trace: nothing is written. */
export async function testEvaluatorAction(
  projectId: string,
  input: unknown,
  traceId: string,
): Promise<ActionResult<PreviewOutcome>> {
  return run("testEvaluator", async () => {
    const db = await requireEvaluatorAccess(projectId);
    const cfg = requireEvalConfig();
    const normalizedTraceId = traceId.trim().toLowerCase();
    if (!isTraceId(normalizedTraceId)) {
      throw new ApiError(400, "invalid_request", "Enter a 32-character trace id.");
    }
    return previewEvaluator(db, cfg, projectId, parseEvaluator(input), normalizedTraceId);
  });
}

export async function runEvaluatorAction(
  projectId: string,
  evaluatorId: string,
  traceId: string,
  force = false,
): Promise<ActionResult<RunOutcome>> {
  return run("runEvaluator", async () => {
    const db = await requireEvaluatorAccess(projectId);
    const cfg = requireEvalConfig();
    if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "Trace not found.");
    const evaluator = await requireEvaluator(db, projectId, evaluatorId);
    const outcome = await runEvaluator(db, cfg, projectId, evaluator, traceId, {
      trigger: "manual",
      force,
    });
    revalidateScores(projectId, traceId);
    revalidateEvaluators(projectId);
    return outcome;
  });
}

/**
 * Run over the traces matching the trace list's current filters (newest
 * first, capped). The environment comes from the selector's cookie, exactly
 * as the list the user is looking at.
 */
export async function runEvaluatorBulkAction(
  projectId: string,
  evaluatorId: string,
  filters: Record<string, string | undefined>,
  force = false,
): Promise<ActionResult<BulkOutcome>> {
  return run("runEvaluatorBulk", async () => {
    const db = await requireEvaluatorAccess(projectId);
    const cfg = requireEvalConfig();
    const [evaluator, view] = await Promise.all([
      requireEvaluator(db, projectId, evaluatorId),
      getEnvironmentView(db, projectId),
    ]);
    const page = await listTraces(
      db,
      projectId,
      { ...parseTraceFilters(filters), environment: view.filter },
      { limit: EVAL_LIMITS.maxBulkTraces },
    );
    const outcome = await runEvaluatorBulk(
      db,
      cfg,
      projectId,
      evaluator,
      page.traces.map((t) => t.id),
      { force },
    );
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}/scores`);
    revalidateEvaluators(projectId);
    return outcome;
  });
}
