import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { API_KEY_PREFIX } from "./api-key-format";
import { newKeyId } from "./ids";

export { API_KEY_PREFIX, redactedKeyReference } from "./api-key-format";

/**
 * Project ingestion keys: `ft_live_<keyId>_<secret>`.
 *   keyId  = 16 hex chars (the apiKeys document id)
 *   secret = 64 hex chars (32 cryptographically random bytes)
 * Only HMAC-SHA-256(pepper, plaintext) is stored. Plaintext is returned once.
 * Server-only: uses node:crypto. Display helpers live in api-key-format.ts.
 */
const API_KEY_RE = /^ft_live_([0-9a-f]{16})_([0-9a-f]{64})$/;

export interface GeneratedApiKey {
  keyId: string;
  plaintext: string;
  lastFour: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = newKeyId();
  const secret = randomBytes(32).toString("hex");
  const plaintext = `${API_KEY_PREFIX}${keyId}_${secret}`;
  return { keyId, plaintext, lastFour: secret.slice(-4) };
}

export function parseApiKey(value: string): { keyId: string } | null {
  const match = API_KEY_RE.exec(value.trim());
  return match ? { keyId: match[1] } : null;
}

export function hashApiKey(plaintext: string, pepper: string): string {
  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}

/** Constant-time comparison of a presented key against a stored digest. */
export function verifyApiKey(plaintext: string, pepper: string, storedHash: string): boolean {
  const computed = Buffer.from(hashApiKey(plaintext, pepper), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (computed.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(computed, stored);
}
