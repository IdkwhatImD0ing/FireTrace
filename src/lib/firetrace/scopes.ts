import { ApiError } from "./errors";

/**
 * API key scopes. A key carries the least privilege it needs:
 *   traces:write   POST /api/v1/traces, MCP record_trace
 *   traces:read    GET  /api/v1/traces, /api/v1/traces/{id}, /api/v1/project, MCP read tools
 *   traces:delete  DELETE /api/v1/traces/{id}, MCP delete_trace
 * Keys created before scopes existed are treated as traces:write only.
 */
export const KEY_SCOPES = ["traces:write", "traces:read", "traces:delete"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export const DEFAULT_KEY_SCOPES: KeyScope[] = ["traces:write", "traces:read"];
export const LEGACY_KEY_SCOPES: KeyScope[] = ["traces:write"];

export const SCOPE_DESCRIPTIONS: Record<KeyScope, string> = {
  "traces:write": "Record traces (ingestion API and MCP record_trace)",
  "traces:read": "List and read traces and project stats (REST and MCP read tools)",
  "traces:delete": "Delete traces (REST and MCP delete_trace)",
};

/** Key lifetime presets offered by the dashboard, in days. `null` = never expires. */
export const EXPIRY_PRESETS: Record<string, number | null> = {
  never: null,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export function isKeyScope(value: unknown): value is KeyScope {
  return typeof value === "string" && (KEY_SCOPES as readonly string[]).includes(value);
}

/** Validate a client-supplied scope list: known values only, deduplicated, non-empty. */
export function normalizeScopes(input: unknown): KeyScope[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_request", "scopes must be an array of scope names.");
  }
  const out: KeyScope[] = [];
  for (const raw of input) {
    if (!isKeyScope(raw)) {
      throw new ApiError(
        400,
        "invalid_request",
        `Unknown scope "${String(raw)}". Valid scopes: ${KEY_SCOPES.join(", ")}.`,
      );
    }
    if (!out.includes(raw)) out.push(raw);
  }
  if (out.length === 0) {
    throw new ApiError(400, "invalid_request", "A key needs at least one scope.");
  }
  return out;
}

/** Scopes as stored on a key document; tolerant of missing/invalid data. */
export function scopesFromDocument(value: unknown): KeyScope[] {
  if (!Array.isArray(value)) return [...LEGACY_KEY_SCOPES];
  const scopes = value.filter(isKeyScope);
  return scopes.length ? [...new Set(scopes)] : [...LEGACY_KEY_SCOPES];
}

export function expiryFromPreset(preset: string | undefined, now = Date.now()): Date | null {
  if (!preset || preset === "never") return null;
  const days = EXPIRY_PRESETS[preset];
  if (days === undefined || days === null) {
    throw new ApiError(
      400,
      "invalid_request",
      `Unknown expiry "${preset}". Use one of: ${Object.keys(EXPIRY_PRESETS).join(", ")}.`,
    );
  }
  return new Date(now + days * 24 * 60 * 60 * 1000);
}
