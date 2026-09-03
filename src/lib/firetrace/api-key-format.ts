/**
 * Browser-safe helpers for displaying project keys. The key material itself
 * (generation, HMAC hashing, verification) lives in api-keys.ts, which uses
 * node:crypto and must never be imported from client components.
 */
export const API_KEY_PREFIX = "ft_live_";

/** Display form: prefix, key id, and last four characters of the secret. */
export function redactedKeyReference(keyId: string, lastFour: string): string {
  return `${API_KEY_PREFIX}${keyId}_…${lastFour}`;
}
