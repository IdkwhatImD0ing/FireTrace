import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { generateApiKey, hashApiKey } from "./api-keys";
import { toApiKeySummary, toProject } from "./convert";
import { ApiError } from "./errors";
import { newProjectId } from "./ids";
import { DEFAULT_KEY_SCOPES, scopesFromDocument, type KeyScope } from "./scopes";
import { deleteScoresForTrace } from "./scores";
import {
  existingKey,
  STATS_COLLECTION,
  statsDayId,
  statsIncrements,
  traceStatsDeltas,
} from "./stats-rollup";
import { TRIAL_MAX_PROJECTS, type Plan } from "./trial";
import type { ApiKeySummary, Project } from "./types";

const DELETE_BATCH = 400;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "project";
}

export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new ApiError(400, "invalid_request", "Project name must be 1-80 characters.");
  }
  return trimmed;
}

export function validateDescription(description: string | undefined): string {
  const trimmed = (description ?? "").trim();
  if (trimmed.length > 500) {
    throw new ApiError(400, "invalid_request", "Description must be at most 500 characters.");
  }
  return trimmed;
}

export async function listProjects(db: Firestore): Promise<Project[]> {
  const snap = await db.collection("projects").orderBy("updatedAt", "desc").get();
  return snap.docs.map((d) => toProject(d.id, d.data()));
}

/** Projects created under one verified email (trial users). Sorted in memory; no composite index needed. */
export async function listProjectsForEmail(db: Firestore, email: string): Promise<Project[]> {
  const snap = await db
    .collection("projects")
    .where("ownerEmail", "==", email.trim().toLowerCase())
    .get();
  return snap.docs
    .map((d) => toProject(d.id, d.data()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(db: Firestore, projectId: string): Promise<Project | null> {
  const snap = await db.collection("projects").doc(projectId).get();
  return snap.exists ? toProject(snap.id, snap.data() ?? {}) : null;
}

export async function requireProject(db: Firestore, projectId: string): Promise<Project> {
  const project = await getProject(db, projectId);
  if (!project) throw new ApiError(404, "not_found", "Project not found.");
  return project;
}

/** Create a project; name and slug are unique within the deployment. */
export async function createProject(
  db: Firestore,
  input: {
    name: string;
    description?: string;
    ownerUid: string;
    ownerEmail?: string | null;
    /** Trial projects are capped by FIRETRACE_TRIAL_TRACE_LIMIT and limited to one per account. */
    plan?: "owner" | "trial";
  },
): Promise<Project> {
  const name = validateProjectName(input.name);
  const description = validateDescription(input.description);
  const slug = slugify(name);
  const plan = input.plan ?? "owner";
  const ownerEmail = input.ownerEmail?.trim().toLowerCase() || null;
  if (plan === "trial" && !ownerEmail) {
    throw new ApiError(400, "invalid_request", "Trial projects need the creator's email.");
  }
  const id = newProjectId();
  const ref = db.collection("projects").doc(id);

  await db.runTransaction(async (tx) => {
    // Trial projects live in a per-account namespace: the cap is checked first so
    // a capped account cannot use name conflicts as an existence oracle, and
    // name/slug uniqueness only looks at that account's own projects.
    if (plan === "trial") {
      const mine = await tx.get(
        db
          .collection("projects")
          .where("ownerEmail", "==", ownerEmail)
          .where("plan", "==", "trial")
          .limit(TRIAL_MAX_PROJECTS),
      );
      if (mine.size >= TRIAL_MAX_PROJECTS) {
        throw new ApiError(
          403,
          "trial_limit_reached",
          `Trial accounts get ${TRIAL_MAX_PROJECTS} project. Deploy your own FireTrace for as many as you like.`,
        );
      }
    }
    const scoped = (q: FirebaseFirestore.Query) =>
      plan === "trial" ? q.where("ownerEmail", "==", ownerEmail) : q;
    const [bySlug, byName] = await Promise.all([
      tx.get(scoped(db.collection("projects").where("slug", "==", slug)).limit(1)),
      tx.get(scoped(db.collection("projects").where("name", "==", name)).limit(1)),
    ]);
    if (!bySlug.empty || !byName.empty) {
      throw new ApiError(
        409,
        "conflict",
        `A project named "${name}" (slug "${slug}") already exists.`,
      );
    }
    tx.set(ref, {
      name,
      slug,
      description,
      ownerUid: input.ownerUid,
      ownerEmail,
      plan,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastTraceAt: null,
      traceCount: 0,
      spanCount: 0,
      estimatedBytes: 0,
      settings: { captureContent: true },
    });
  });

  const created = await getProject(db, id);
  if (!created) throw new ApiError(500, "internal_error", "Project was not persisted.");
  return created;
}

export async function updateProject(
  db: Firestore,
  projectId: string,
  input: { name: string; description?: string },
): Promise<Project> {
  const name = validateProjectName(input.name);
  const description = validateDescription(input.description);
  const slug = slugify(name);
  const ref = db.collection("projects").doc(projectId);

  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists) throw new ApiError(404, "not_found", "Project not found.");
    const trialEmail =
      current.get("plan") === "trial" ? String(current.get("ownerEmail") ?? "") : null;
    const scoped = (q: FirebaseFirestore.Query) =>
      trialEmail ? q.where("ownerEmail", "==", trialEmail) : q;
    const [bySlug, byName] = await Promise.all([
      tx.get(scoped(db.collection("projects").where("slug", "==", slug)).limit(2)),
      tx.get(scoped(db.collection("projects").where("name", "==", name)).limit(2)),
    ]);
    const clash = [...bySlug.docs, ...byName.docs].some((d) => d.id !== projectId);
    if (clash) {
      throw new ApiError(409, "conflict", `Another project already uses the name "${name}".`);
    }
    tx.update(ref, { name, slug, description, updatedAt: FieldValue.serverTimestamp() });
  });

  return requireProject(db, projectId);
}

async function deleteQueryInBatches(
  db: Firestore,
  query: FirebaseFirestore.Query,
  onProgress?: (deleted: number) => void,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    // Only the references are needed; select() keeps the payloads in Firestore.
    const snap = await query.select().limit(DELETE_BATCH).get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snap.size;
    onProgress?.(deleted);
  }
}

/** Delete one trace and all of its span documents, then fix project counters. */
export async function deleteTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
): Promise<void> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);
  const traceSnap = await traceRef.get();
  if (!traceSnap.exists) throw new ApiError(404, "not_found", "Trace not found.");

  await deleteQueryInBatches(db, traceRef.collection("spans"));
  // Score bytes are counted on the trace, so the transaction below gives them back too.
  await deleteScoresForTrace(db, projectId, traceId);
  await deleteQueryInBatches(db, projectRef.collection("evalRuns").where("traceId", "==", traceId));

  await db.runTransaction(async (tx) => {
    const [projectSnap, current] = await Promise.all([tx.get(projectRef), tx.get(traceRef)]);
    if (!current.exists) return; // deleted concurrently; counters already adjusted
    const d = current.data() ?? {};
    const spanCount = typeof d.spanCount === "number" ? d.spanCount : 0;
    const bytes = typeof d.estimatedBytes === "number" ? d.estimatedBytes : 0;
    const startedAt = d.startedAt instanceof Timestamp ? d.startedAt.toDate().toISOString() : null;
    const dayRef = startedAt
      ? projectRef.collection(STATS_COLLECTION).doc(statsDayId(startedAt))
      : null;
    const daySnap = dayRef ? await tx.get(dayRef) : null;

    tx.delete(traceRef);
    if (projectSnap.exists) {
      const p = projectSnap.data() ?? {};
      tx.update(projectRef, {
        traceCount: Math.max(0, (p.traceCount ?? 0) - 1),
        spanCount: Math.max(0, (p.spanCount ?? 0) - spanCount),
        estimatedBytes: Math.max(0, (p.estimatedBytes ?? 0) - bytes),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    // Give the day's rollup back; a day that was never rolled up (pre-dashboard trace) is left alone.
    if (dayRef && startedAt && daySnap?.exists) {
      const day = daySnap.data() ?? {};
      const model = typeof d.model === "string" ? d.model : null;
      const name = typeof d.name === "string" ? d.name : "";
      tx.set(
        dayRef,
        statsIncrements(
          traceStatsDeltas(
            {
              name,
              status: typeof d.status === "string" ? d.status : "unset",
              startedAt,
              durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
              model,
              usage: d.usage && typeof d.usage === "object" ? d.usage : {},
              costUsd: typeof d.costUsd === "number" ? d.costUsd : null,
              spanCount,
            },
            { model: existingKey(day.byModel, model), name: existingKey(day.byName, name) },
          ),
          -1,
        ),
        { merge: true },
      );
    }
  });
}

/**
 * Delete a project: every API key, the project document, then every trace's
 * spans, every trace, every score, and the evaluators with their run log.
 * Firestore does not cascade, so this walks the tree and awaits completion.
 */
export async function deleteProject(
  db: Firestore,
  projectId: string,
  onProgress?: (message: string) => void,
): Promise<{
  traces: number;
  spans: number;
  apiKeys: number;
  scores: number;
  evaluators: number;
  evalRuns: number;
}> {
  const projectRef = db.collection("projects").doc(projectId);
  if (!(await projectRef.get()).exists) throw new ApiError(404, "not_found", "Project not found.");

  // Stop ingestion first (keys, then the project document the ingest
  // transaction checks) so concurrent writes cannot leave orphans behind.
  const apiKeys = await deleteQueryInBatches(
    db,
    db.collection("apiKeys").where("projectId", "==", projectId),
  );
  await projectRef.delete();

  let traces = 0;
  let spans = 0;
  for (;;) {
    const page = await projectRef.collection("traces").select().limit(50).get();
    if (page.empty) break;
    for (const trace of page.docs) {
      spans += await deleteQueryInBatches(db, trace.ref.collection("spans"));
      await trace.ref.delete();
      traces++;
    }
    onProgress?.(`Deleted ${traces} traces and ${spans} spans so far`);
  }
  const scores = await deleteQueryInBatches(db, projectRef.collection("scores"));
  const evaluators = await deleteQueryInBatches(db, projectRef.collection("evaluators"));
  const evalRuns = await deleteQueryInBatches(db, projectRef.collection("evalRuns"));
  await deleteQueryInBatches(db, projectRef.collection(STATS_COLLECTION));
  return { traces, spans, apiKeys, scores, evaluators, evalRuns };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export async function listApiKeys(db: Firestore, projectId: string): Promise<ApiKeySummary[]> {
  const snap = await db
    .collection("apiKeys")
    .where("projectId", "==", projectId)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => toApiKeySummary(d.id, d.data()));
}

export function validateKeyLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new ApiError(400, "invalid_request", "Key label must be 1-80 characters.");
  }
  return trimmed;
}

/** Returns the plaintext key exactly once. */
export async function createApiKey(
  db: Firestore,
  input: {
    projectId: string;
    label: string;
    createdByUid: string;
    pepper: string;
    scopes?: KeyScope[];
    expiresAt?: Date | null;
    /** Recorded on the key so trial keys can be switched off with trial mode. */
    plan?: Plan;
    /** Trial projects: refuse when this many keys (revoked included) already exist. */
    maxKeys?: number;
  },
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  await requireProject(db, input.projectId);
  const label = validateKeyLabel(input.label);
  await assertKeyQuota(db, input.projectId, input.maxKeys);
  const generated = generateApiKey();
  const ref = db.collection("apiKeys").doc(generated.keyId);
  await ref.create({
    projectId: input.projectId,
    label,
    keyHash: hashApiKey(generated.plaintext, input.pepper),
    lastFour: generated.lastFour,
    createdAt: FieldValue.serverTimestamp(),
    createdByUid: input.createdByUid,
    revokedAt: null,
    scopes: input.scopes?.length ? input.scopes : DEFAULT_KEY_SCOPES,
    expiresAt: input.expiresAt ? Timestamp.fromDate(input.expiresAt) : null,
    lastUsedAt: null,
    plan: input.plan ?? "owner",
  });
  const snap = await ref.get();
  return { key: toApiKeySummary(snap.id, snap.data() ?? {}), plaintext: generated.plaintext };
}

export async function revokeApiKey(db: Firestore, projectId: string, keyId: string): Promise<void> {
  const ref = db.collection("apiKeys").doc(keyId);
  const snap = await ref.get();
  if (!snap.exists || snap.get("projectId") !== projectId) {
    throw new ApiError(404, "not_found", "API key not found in this project.");
  }
  if (snap.get("revokedAt")) return;
  await ref.update({ revokedAt: FieldValue.serverTimestamp() });
}

/** Trial projects may hold only a few keys (revoked ones count); owner projects are unlimited. */
async function assertKeyQuota(
  db: Firestore,
  projectId: string,
  maxKeys: number | undefined,
): Promise<void> {
  if (maxKeys === undefined) return;
  const existing = await db
    .collection("apiKeys")
    .where("projectId", "==", projectId)
    .limit(maxKeys)
    .get();
  if (existing.size >= maxKeys) {
    throw new ApiError(
      403,
      "trial_limit_reached",
      `Trial projects can hold ${maxKeys} API keys, revoked ones included. Deploy your own FireTrace for unlimited keys.`,
    );
  }
}

/** Rotate: revoke the old key and issue a new one with the same label, atomically. */
export async function rotateApiKey(
  db: Firestore,
  input: {
    projectId: string;
    keyId: string;
    createdByUid: string;
    pepper: string;
    /** Trial projects: refuse when this many keys (revoked included) already exist. */
    maxKeys?: number;
  },
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  const oldRef = db.collection("apiKeys").doc(input.keyId);
  const generated = generateApiKey();
  const newRef = db.collection("apiKeys").doc(generated.keyId);

  await db.runTransaction(async (tx) => {
    const old = await tx.get(oldRef);
    if (!old.exists || old.get("projectId") !== input.projectId) {
      throw new ApiError(404, "not_found", "API key not found in this project.");
    }
    if (input.maxKeys !== undefined) {
      const existing = await tx.get(
        db.collection("apiKeys").where("projectId", "==", input.projectId).limit(input.maxKeys),
      );
      if (existing.size >= input.maxKeys) {
        throw new ApiError(
          403,
          "trial_limit_reached",
          `Trial projects can hold ${input.maxKeys} API keys, revoked ones included. Deploy your own FireTrace for unlimited keys.`,
        );
      }
    }
    const label = `${old.get("label") ?? "key"}`.slice(0, 80);
    tx.update(oldRef, { revokedAt: FieldValue.serverTimestamp() });
    tx.create(newRef, {
      projectId: input.projectId,
      label,
      keyHash: hashApiKey(generated.plaintext, input.pepper),
      lastFour: generated.lastFour,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: input.createdByUid,
      revokedAt: null,
      scopes: scopesFromDocument(old.get("scopes")),
      expiresAt: old.get("expiresAt") instanceof Timestamp ? old.get("expiresAt") : null,
      lastUsedAt: null,
      plan: old.get("plan") === "trial" ? "trial" : "owner",
    });
  });

  const snap = await newRef.get();
  return { key: toApiKeySummary(snap.id, snap.data() ?? {}), plaintext: generated.plaintext };
}
