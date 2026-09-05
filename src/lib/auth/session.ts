import "server-only";
import type { DecodedIdToken } from "firebase-admin/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { serverEnv, type ServerEnv } from "@/lib/env/server";
import { adminAuth } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/firetrace/errors";

/**
 * Dashboard identity: Firebase ID token -> server-verified session cookie.
 * The cookie is HTTP-only, SameSite=Lax, Secure in production, and expires
 * after SESSION_TTL_MS. Every server read re-verifies the cookie with the
 * Admin SDK and re-checks the email allowlist; a cookie's presence alone
 * proves nothing.
 */
export const SESSION_COOKIE = "firetrace_session";
export const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export type Role = "owner" | "trial";

export interface Owner {
  uid: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** owner = on DASHBOARD_ALLOWED_EMAILS (sees everything); trial = capped guest, own projects only. */
  role: Role;
}

export class NotAllowedError extends ApiError {
  constructor(message: string) {
    super(403, "forbidden", message);
    this.name = "NotAllowedError";
  }
}

/**
 * Pure allowlist decision. Allowlisted emails are owners. When trial mode is
 * on (trialTraceLimit > 0) any other verified email becomes a trial user;
 * otherwise it is rejected. Exported for unit tests.
 */
export function isAllowedIdentity(
  token: Pick<DecodedIdToken, "email" | "email_verified">,
  env: Pick<ServerEnv, "allowedEmails" | "useEmulators" | "isProduction" | "trialTraceLimit">,
): { allowed: true; email: string; role: Role } | { allowed: false; reason: string } {
  const email = token.email?.trim().toLowerCase();
  if (!email) return { allowed: false, reason: "The signed-in account has no email address." };
  const emulatorBypass = env.useEmulators && !env.isProduction && env.allowedEmails.length === 0;
  if (emulatorBypass) return { allowed: true, email, role: "owner" };
  if (!token.email_verified) {
    return {
      allowed: false,
      reason: "Verify the email address on this account, then sign in again.",
    };
  }
  if (env.allowedEmails.includes(email)) return { allowed: true, email, role: "owner" };
  if (env.trialTraceLimit > 0) return { allowed: true, email, role: "trial" };
  return { allowed: false, reason: `${email} is not in the dashboard allowlist.` };
}

function ownerFromToken(token: DecodedIdToken, email: string, role: Role): Owner {
  return {
    uid: token.uid,
    email,
    name: typeof token.name === "string" ? token.name : null,
    picture: typeof token.picture === "string" ? token.picture : null,
    role,
  };
}

/** Exchange a Firebase ID token for a session cookie value. Throws NotAllowedError. */
export async function createSessionCookie(
  idToken: string,
): Promise<{ cookie: string; owner: Owner }> {
  const env = serverEnv();
  const auth = adminAuth();
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    throw new ApiError(
      401,
      "unauthorized",
      "The sign-in token is invalid or expired. Sign in again.",
    );
  }
  const decision = isAllowedIdentity(decoded, env);
  if (!decision.allowed) throw new NotAllowedError(decision.reason);
  const cookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_TTL_MS });
  return { cookie, owner: ownerFromToken(decoded, decision.email, decision.role) };
}

export function sessionCookieOptions(env: ServerEnv) {
  return {
    httpOnly: true,
    secure: env.isProduction || env.appUrl.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Verify a raw cookie value. Returns null for missing/invalid/expired/disallowed. */
export async function verifySessionCookieValue(value: string | undefined): Promise<Owner | null> {
  if (!value) return null;
  try {
    const env = serverEnv();
    const decoded = await adminAuth().verifySessionCookie(value, true);
    const decision = isAllowedIdentity(decoded, env);
    if (!decision.allowed) return null;
    return ownerFromToken(decoded, decision.email, decision.role);
  } catch {
    return null;
  }
}

/**
 * Current owner from the request cookies, or null. Safe to call in layouts.
 * Memoized per request: layouts and the page share one verification
 * (revocation check included) instead of each repeating it.
 */
export const getOwner = cache(async (): Promise<Owner | null> => {
  const store = await cookies();
  return verifySessionCookieValue(store.get(SESSION_COOKIE)?.value);
});

/** Owner or a 401 ApiError. Use in route handlers and server actions. */
export async function requireOwner(): Promise<Owner> {
  const owner = await getOwner();
  if (!owner) throw new ApiError(401, "unauthorized", "Sign in to continue.");
  return owner;
}

/**
 * Owner or a redirect to /login. Every dashboard page calls this itself:
 * layouts are not re-rendered on client-side navigation, so the layout check
 * alone would not protect page data.
 */
export async function requireOwnerOrRedirect(): Promise<Owner> {
  const owner = await getOwner();
  if (!owner) redirect("/login");
  return owner;
}
