"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/firetrace/errors";
import { isProjectId, isTraceId } from "@/lib/firetrace/ids";
import {
  createApiKey,
  createProject,
  deleteProject,
  deleteTrace,
  revokeApiKey,
  rotateApiKey,
  requireProject,
  updateProject,
} from "@/lib/firetrace/projects";
import { expiryFromPreset, normalizeScopes } from "@/lib/firetrace/scopes";
import type { ApiKeySummary } from "@/lib/firetrace/types";
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

function assertProjectId(projectId: string): void {
  if (!isProjectId(projectId)) throw new ApiError(404, "not_found", "Project not found.");
}

export async function createProjectAction(input: { name: string; description?: string }) {
  return run("createProject", async () => {
    const owner = await requireOwner();
    const project = await createProject(adminDb(), { ...input, ownerUid: owner.uid });
    revalidatePath("/projects");
    return { projectId: project.id };
  });
}

export async function updateProjectAction(
  projectId: string,
  input: { name: string; description?: string },
) {
  return run("updateProject", async () => {
    await requireOwner();
    assertProjectId(projectId);
    await updateProject(adminDb(), projectId, input);
    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    revalidatePath(`/projects/${projectId}/settings`);
    return undefined;
  });
}

export async function deleteProjectAction(projectId: string, confirmName: string) {
  return run("deleteProject", async () => {
    await requireOwner();
    assertProjectId(projectId);
    const db = adminDb();
    const project = await requireProject(db, projectId);
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
  input: { label: string; scopes: string[]; expiry?: string },
): Promise<ActionResult<{ key: ApiKeySummary; plaintext: string }>> {
  return run("createApiKey", async () => {
    const owner = await requireOwner();
    assertProjectId(projectId);
    const result = await createApiKey(adminDb(), {
      projectId,
      label: input.label,
      createdByUid: owner.uid,
      pepper: serverEnv().keyPepper,
      scopes: normalizeScopes(input.scopes),
      expiresAt: expiryFromPreset(input.expiry),
    });
    revalidatePath(`/projects/${projectId}/settings`);
    revalidatePath(`/projects/${projectId}`);
    return result;
  });
}

export async function revokeApiKeyAction(projectId: string, keyId: string) {
  return run("revokeApiKey", async () => {
    await requireOwner();
    assertProjectId(projectId);
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
    assertProjectId(projectId);
    const result = await rotateApiKey(adminDb(), {
      projectId,
      keyId,
      createdByUid: owner.uid,
      pepper: serverEnv().keyPepper,
    });
    revalidatePath(`/projects/${projectId}/settings`);
    return result;
  });
}

export async function deleteTraceAction(projectId: string, traceId: string) {
  return run("deleteTrace", async () => {
    await requireOwner();
    assertProjectId(projectId);
    if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "Trace not found.");
    await deleteTrace(adminDb(), projectId, traceId);
    revalidatePath(`/projects/${projectId}`);
    return undefined;
  });
}
