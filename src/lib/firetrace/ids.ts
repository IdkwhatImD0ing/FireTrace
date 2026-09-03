import { randomBytes } from "node:crypto";

/**
 * Identifier rules (OpenTelemetry-shaped):
 *   trace id  = 32 lowercase hex characters (16 random bytes)
 *   span id   = 16 lowercase hex characters (8 random bytes)
 * Uppercase hex is accepted on input and normalized to lowercase.
 */
export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;
export const PROJECT_ID_RE = /^[0-9a-f]{24}$/;
export const KEY_ID_RE = /^[0-9a-f]{16}$/;

export function normalizeHexId(value: string, length: number): string | null {
  if (typeof value !== "string" || value.length !== length) return null;
  const lower = value.toLowerCase();
  return /^[0-9a-f]+$/.test(lower) ? lower : null;
}

export function isTraceId(value: string): boolean {
  return TRACE_ID_RE.test(value);
}

export function isSpanId(value: string): boolean {
  return SPAN_ID_RE.test(value);
}

export function isProjectId(value: string): boolean {
  return PROJECT_ID_RE.test(value);
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function newProjectId(): string {
  return randomBytes(12).toString("hex");
}

export function newKeyId(): string {
  return randomBytes(8).toString("hex");
}

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}
