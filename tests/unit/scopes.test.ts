import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/firetrace/errors";
import {
  DEFAULT_KEY_SCOPES,
  EXPIRY_PRESETS,
  expiryFromPreset,
  isKeyScope,
  KEY_SCOPES,
  LEGACY_KEY_SCOPES,
  normalizeScopes,
  scopesFromDocument,
} from "@/lib/firetrace/scopes";

describe("scopes", () => {
  it("defines three scopes with write+read as the default and write-only for legacy keys", () => {
    expect(KEY_SCOPES).toEqual(["traces:write", "traces:read", "traces:delete"]);
    expect(DEFAULT_KEY_SCOPES).toEqual(["traces:write", "traces:read"]);
    expect(LEGACY_KEY_SCOPES).toEqual(["traces:write"]);
    expect(isKeyScope("traces:read")).toBe(true);
    expect(isKeyScope("admin")).toBe(false);
    expect(isKeyScope(42)).toBe(false);
  });

  it("normalizeScopes dedupes, keeps order, and rejects unknown, empty, or non-array input", () => {
    expect(normalizeScopes(["traces:read", "traces:write", "traces:read"])).toEqual([
      "traces:read",
      "traces:write",
    ]);
    expect(() => normalizeScopes(["traces:read", "root"])).toThrowError(ApiError);
    expect(() => normalizeScopes([])).toThrowError(/at least one scope/);
    expect(() => normalizeScopes("traces:read")).toThrowError(/array/);
    try {
      normalizeScopes(["nope"]);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toContain('Unknown scope "nope"');
    }
  });

  it("scopesFromDocument tolerates missing or corrupt data by falling back to legacy write-only", () => {
    expect(scopesFromDocument(undefined)).toEqual(["traces:write"]);
    expect(scopesFromDocument(null)).toEqual(["traces:write"]);
    expect(scopesFromDocument("traces:read")).toEqual(["traces:write"]);
    expect(scopesFromDocument([])).toEqual(["traces:write"]);
    expect(scopesFromDocument(["bogus"])).toEqual(["traces:write"]);
    expect(scopesFromDocument(["traces:read", "bogus", "traces:read"])).toEqual(["traces:read"]);
    const legacy = scopesFromDocument(undefined);
    legacy.push("traces:delete");
    expect(LEGACY_KEY_SCOPES).toEqual(["traces:write"]);
  });

  it("expiryFromPreset maps presets to absolute dates and rejects unknown presets", () => {
    const now = Date.UTC(2026, 8, 3);
    expect(expiryFromPreset(undefined, now)).toBeNull();
    expect(expiryFromPreset("never", now)).toBeNull();
    expect(expiryFromPreset("30d", now)?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(expiryFromPreset("90d", now)?.toISOString()).toBe("2026-12-02T00:00:00.000Z");
    expect(expiryFromPreset("1y", now)?.toISOString()).toBe("2027-09-03T00:00:00.000Z");
    expect(() => expiryFromPreset("2h", now)).toThrowError(/Unknown expiry/);
    expect(Object.keys(EXPIRY_PRESETS)).toEqual(["never", "30d", "90d", "1y"]);
  });
});
