import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { parseApiKey, verifyApiKey } from "./api-keys";
import { ApiError } from "./errors";
import { scopesFromDocument, type KeyScope } from "./scopes";

export interface AuthenticatedKey {
  keyId: string;
  projectId: string;
  scopes: KeyScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  /** Plan of the project when the key was issued; trial keys die with trial mode. */
  plan: "owner" | "trial";
}

/** How often `lastUsedAt` is refreshed for a busy key (avoids a write per request). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function invalidKey(): ApiError {
  return new ApiError(
    401,
    "invalid_api_key",
    "The project API key is missing, invalid, revoked, or expired.",
  );
}

/** Pure decision on a key document. Exported for unit tests. */
export function keyIsUsable(
  doc: { revokedAt?: unknown; expiresAt?: unknown },
  now = Date.now(),
): boolean {
  if (doc.revokedAt) return false;
  const exp = doc.expiresAt;
  if (exp instanceof Timestamp) return exp.toMillis() > now;
  if (exp instanceof Date) return exp.getTime() > now;
  return true;
}

/**
 * Resolve a bearer key to its project and scopes. Every failure is the same
 * 401 so the response never reveals whether a key id exists.
 */
export async function authenticateApiKey(
  db: Firestore,
  authorizationHeader: string | null,
  pepper: string,
): Promise<AuthenticatedKey> {
  if (!authorizationHeader) throw invalidKey();
  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  const presented = rest.join("");
  if (!/^bearer$/i.test(scheme) || !presented) throw invalidKey();
  const parsed = parseApiKey(presented);
  if (!parsed) throw invalidKey();

  const snap = await db.collection("apiKeys").doc(parsed.keyId).get();
  if (!snap.exists) throw invalidKey();
  const data = snap.data() ?? {};
  if (!keyIsUsable(data)) throw invalidKey();
  if (typeof data.keyHash !== "string" || typeof data.projectId !== "string") throw invalidKey();
  if (!verifyApiKey(presented, pepper, data.keyHash)) throw invalidKey();
  return {
    keyId: parsed.keyId,
    projectId: data.projectId,
    scopes: scopesFromDocument(data.scopes),
    expiresAt: data.expiresAt instanceof Timestamp ? data.expiresAt.toDate() : null,
    lastUsedAt: data.lastUsedAt instanceof Timestamp ? data.lastUsedAt.toDate() : null,
    plan: data.plan === "trial" ? "trial" : "owner",
  };
}

/**
 * Keys issued for trial projects stop working entirely once trial mode is
 * switched off, so a former trial user cannot keep reading or deleting
 * through the API after they can no longer sign in.
 */
export function requireTrialModeForKey(auth: AuthenticatedKey, trialTraceLimit: number): void {
  if (auth.plan === "trial" && trialTraceLimit <= 0) {
    throw new ApiError(
      401,
      "invalid_api_key",
      "Trial mode is switched off on this instance; keys of trial projects are disabled.",
    );
  }
}

/** 403 unless the key carries `scope`. */
export function requireScope(auth: AuthenticatedKey, scope: KeyScope): void {
  if (!auth.scopes.includes(scope)) {
    throw new ApiError(
      403,
      "insufficient_scope",
      `This API key lacks the "${scope}" scope. Create a key with that scope under Project settings.`,
    );
  }
}

/** Best-effort, throttled `lastUsedAt` bookkeeping. Never throws. */
export async function touchApiKey(db: Firestore, auth: AuthenticatedKey): Promise<void> {
  const stale = !auth.lastUsedAt || Date.now() - auth.lastUsedAt.getTime() > TOUCH_INTERVAL_MS;
  if (!stale) return;
  await db
    .collection("apiKeys")
    .doc(auth.keyId)
    .update({ lastUsedAt: FieldValue.serverTimestamp() })
    .catch(() => undefined);
}
