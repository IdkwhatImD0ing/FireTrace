import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { generateApiKey, hashApiKey } from "./api-keys";
import { toApiKeySummary, toProject } from "./convert";
import { ApiError } from "./errors";
import { newProjectId } from "./ids";
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
  input: { name: string; description?: string; ownerUid: string },
): Promise<Project> {
  const name = validateProjectName(input.name);
  const description = validateDescription(input.description);
  const slug = slugify(name);
  const id = newProjectId();
  const ref = db.collection("projects").doc(id);

  await db.runTransaction(async (tx) => {
    const [bySlug, byName] = await Promise.all([
      tx.get(db.collection("projects").where("slug", "==", slug).limit(1)),
      tx.get(db.collection("projects").where("name", "==", name).limit(1)),
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
    const [bySlug, byName] = await Promise.all([
      tx.get(db.collection("projects").where("slug", "==", slug).limit(2)),
      tx.get(db.collection("projects").where("name", "==", name).limit(2)),
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
    const snap = await query.limit(DELETE_BATCH).get();
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

  await db.runTransaction(async (tx) => {
    const [projectSnap, current] = await Promise.all([tx.get(projectRef), tx.get(traceRef)]);
    if (!current.exists) return; // deleted concurrently; counters already adjusted
    const spanCount = typeof current.get("spanCount") === "number" ? current.get("spanCount") : 0;
    const bytes =
      typeof current.get("estimatedBytes") === "number" ? current.get("estimatedBytes") : 0;
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
  });
}

/**
 * Delete a project: every trace's spans, every trace, every API key, then the
 * project document. Firestore does not cascade, so this walks the tree and
 * awaits completion.
 */
export async function deleteProject(
  db: Firestore,
  projectId: string,
  onProgress?: (message: string) => void,
): Promise<{ traces: number; spans: number; apiKeys: number }> {
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
    const page = await projectRef.collection("traces").limit(50).get();
    if (page.empty) break;
    for (const trace of page.docs) {
      spans += await deleteQueryInBatches(db, trace.ref.collection("spans"));
      await trace.ref.delete();
      traces++;
    }
    onProgress?.(`Deleted ${traces} traces and ${spans} spans so far`);
  }
  return { traces, spans, apiKeys };
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
  input: { projectId: string; label: string; createdByUid: string; pepper: string },
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  await requireProject(db, input.projectId);
  const label = validateKeyLabel(input.label);
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

/** Rotate: revoke the old key and issue a new one with the same label, atomically. */
export async function rotateApiKey(
  db: Firestore,
  input: { projectId: string; keyId: string; createdByUid: string; pepper: string },
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  const oldRef = db.collection("apiKeys").doc(input.keyId);
  const generated = generateApiKey();
  const newRef = db.collection("apiKeys").doc(generated.keyId);

  await db.runTransaction(async (tx) => {
    const old = await tx.get(oldRef);
    if (!old.exists || old.get("projectId") !== input.projectId) {
      throw new ApiError(404, "not_found", "API key not found in this project.");
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
    });
  });

  const snap = await newRef.get();
  return { key: toApiKeySummary(snap.id, snap.data() ?? {}), plaintext: generated.plaintext };
}
