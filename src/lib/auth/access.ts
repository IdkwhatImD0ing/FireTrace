import type { Firestore } from "firebase-admin/firestore";
import { cache } from "react";
import type { Owner } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env/server";
import { ApiError } from "@/lib/firetrace/errors";
import { isProjectId } from "@/lib/firetrace/ids";
import { getProject, listProjects, listProjectsForEmail } from "@/lib/firetrace/projects";
import { effectivePlan } from "@/lib/firetrace/trial";
import type { Project } from "@/lib/firetrace/types";

/**
 * Project visibility. Allowlisted owners see every project in the deployment.
 * Trial accounts (FIRETRACE_TRIAL_TRACE_LIMIT > 0, email not on the allowlist)
 * see only trial projects they created, matched on the verified email so a
 * recreated Firebase account keeps its history and its cap. A co-owner who is
 * later removed from the allowlist therefore loses the projects they created
 * as an owner. Inaccessible and non-existent projects are indistinguishable
 * (both 404) so a trial user cannot probe for ids.
 */
export function canAccessProject(
  owner: Pick<Owner, "email" | "role">,
  project: Pick<Project, "plan" | "ownerEmail">,
  allowedEmails: readonly string[],
): boolean {
  if (owner.role === "owner") return true;
  return (
    effectivePlan(project, allowedEmails) === "trial" &&
    project.ownerEmail !== null &&
    project.ownerEmail.toLowerCase() === owner.email.toLowerCase()
  );
}

export async function listProjectsFor(db: Firestore, owner: Owner): Promise<Project[]> {
  if (owner.role === "owner") return listProjects(db);
  const { allowedEmails } = serverEnv();
  const mine = await listProjectsForEmail(db, owner.email);
  return mine.filter((p) => canAccessProject(owner, p, allowedEmails));
}

async function loadAccessibleProject(
  db: Firestore,
  owner: Owner,
  projectId: string,
): Promise<Project | null> {
  if (!isProjectId(projectId)) return null;
  const project = await getProject(db, projectId);
  if (!project || !canAccessProject(owner, project, serverEnv().allowedEmails)) return null;
  return project;
}

/**
 * Project the caller may open, or null. Validates the id shape too. Memoized
 * per request so the project layout and its page share one document read.
 */
export const getAccessibleProject = cache(loadAccessibleProject);

/**
 * Project the caller may open, or a 404 ApiError. Not memoized: server actions
 * and route handlers read fresh, so a mutation never sees a stale project.
 */
export async function requireAccessibleProject(
  db: Firestore,
  owner: Owner,
  projectId: string,
): Promise<Project> {
  const project = await loadAccessibleProject(db, owner, projectId);
  if (!project) throw new ApiError(404, "not_found", "Project not found.");
  return project;
}
