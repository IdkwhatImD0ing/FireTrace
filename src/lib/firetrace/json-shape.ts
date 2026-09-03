import type { JsonValue } from "./schema";

/**
 * Structural limits Firestore enforces at commit time, checked up front so the
 * API answers 400/413 instead of a 500 from the database:
 *  - maps may nest at most 20 levels deep
 *  - field names must be non-empty and not use the reserved __name__ form
 *  - "__proto__" is rejected outright (it is not a plain property in JS)
 */
export const MAX_JSON_DEPTH = 20;
export const MAX_KEY_BYTES = 1500;
const RESERVED_KEY = /^__.*__$/;

export function validateJsonShape(value: JsonValue, path: string): string | null {
  const stack: Array<{ value: JsonValue; path: string; depth: number }> = [
    { value, path, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value: v, path: p, depth } = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth >= MAX_JSON_DEPTH) return `${p} nests deeper than ${MAX_JSON_DEPTH} levels`;
    if (Array.isArray(v)) {
      v.forEach((item, i) => stack.push({ value: item, path: `${p}[${i}]`, depth: depth + 1 }));
      continue;
    }
    for (const key of Object.keys(v)) {
      if (key.length === 0) return `${p} contains an empty field name`;
      if (key === "__proto__" || RESERVED_KEY.test(key)) {
        return `${p} contains the reserved field name "${key}"`;
      }
      if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
        return `${p} contains a field name longer than ${MAX_KEY_BYTES} bytes`;
      }
      stack.push({ value: v[key], path: `${p}.${key}`, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Approximation of Firestore's own document-size accounting (strings are
 * UTF-8 bytes + 1, numbers 8 bytes, booleans/null 1 byte, field names count),
 * which is what the 1 MiB document limit is measured against. Timestamps are
 * carried as ISO strings here and counted as such (an over-estimate).
 */
export function firestoreSizeEstimate(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 1;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (Array.isArray(value))
    return value.reduce<number>((sum, v) => sum + firestoreSizeEstimate(v), 0);
  if (typeof value === "object") {
    let sum = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sum += Buffer.byteLength(k, "utf8") + 1 + firestoreSizeEstimate(v);
    }
    return sum;
  }
  return 8;
}
