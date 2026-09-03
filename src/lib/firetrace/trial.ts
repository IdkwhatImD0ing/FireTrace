import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Trial mode: when FIRETRACE_TRIAL_TRACE_LIMIT is greater than zero, verified
 * accounts that are not on DASHBOARD_ALLOWED_EMAILS may sign in, create one
 * project, hold a few API keys, and record that many traces in total, ever.
 *
 * Accounting is keyed on the verified email, not the Firebase uid: a user can
 * delete and recreate their Firebase account for free, but not their email.
 * The counter in `trialUsage/{subject}` only increases; deleting traces or
 * the project hands nothing back.
 *
 * A project's stored `plan` is what it was at creation. Whether the cap
 * applies is decided per request by `effectivePlan`, so promoting a trial
 * user to the allowlist lifts the cap and demoting a co-owner does not turn
 * their old projects into trial projects they may keep using.
 */
export const TRIAL_USAGE_COLLECTION = "trialUsage";
export const TRIAL_MAX_PROJECTS = 1;
export const TRIAL_MAX_KEYS = 5;

export type Plan = "owner" | "trial";

export interface TrialUsage {
  tracesUsed: number;
}

/** Stable, non-reversible id for a verified email. */
export function trialSubject(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * The plan that applies right now. A trial-plan project whose creator has
 * since been allowlisted behaves as an owner project; an owner-plan project
 * never becomes a trial project.
 */
export function effectivePlan(
  project: { plan: Plan; ownerEmail: string | null },
  allowedEmails: readonly string[],
): Plan {
  if (project.plan !== "trial") return "owner";
  const email = project.ownerEmail?.toLowerCase();
  return email && allowedEmails.includes(email) ? "owner" : "trial";
}

export async function getTrialUsage(db: Firestore, subject: string): Promise<TrialUsage> {
  const snap = await db.collection(TRIAL_USAGE_COLLECTION).doc(subject).get();
  const used = snap.get("tracesUsed");
  return { tracesUsed: typeof used === "number" && used > 0 ? Math.floor(used) : 0 };
}

/** Where a capped trial user is sent: the README section with both guides and the agent prompt. */
export function deployYourOwnUrl(repositoryUrl: string): string {
  return `${repositoryUrl.replace(/\/+$/, "")}#deploy-your-own`;
}

export function trialLimitMessage(limit: number, repositoryUrl: string): string {
  if (limit <= 0) {
    return (
      "Trial mode is switched off on this FireTrace instance, so trial projects can no longer record traces. " +
      `Deploy your own FireTrace for unlimited retention: ${deployYourOwnUrl(repositoryUrl)}`
    );
  }
  return (
    `This FireTrace instance is its owner's personal deployment. Trial accounts can record ${limit} ` +
    `trace${limit === 1 ? "" : "s"} in total and this account has used them all. ` +
    `Deploy your own FireTrace for unlimited retention: ${deployYourOwnUrl(repositoryUrl)}`
  );
}
