import { createHash } from "node:crypto";
import type { JsonValue } from "./schema";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace, arrays in
 * order. Two payloads that differ only in key order hash identically.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key] as JsonValue);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable content hash of a normalized trace, used for idempotent ingestion. */
export function hashCanonical(value: JsonValue): string {
  return sha256Hex(canonicalJson(value));
}
