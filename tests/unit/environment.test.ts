import { describe, expect, it } from "vitest";
import {
  ALL_ENVIRONMENTS,
  defaultEnvironmentSelection,
  ENVIRONMENT_PRESETS,
  environmentFilterOf,
  environmentFromDocument,
  environmentLabel,
  isEnvironmentSelection,
  normalizeEnvironment,
  parseEnvironmentFilter,
  sortEnvironments,
  storedEnvironment,
  UNASSIGNED_ENVIRONMENT,
} from "@/lib/firetrace/environment";
import { ApiError } from "@/lib/firetrace/errors";
import { envStatsDocId, envStatsKey, UNASSIGNED_STATS_KEY } from "@/lib/firetrace/stats-rollup";

function status(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError)
      return { status: err.status, code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected an ApiError");
}

describe("normalizeEnvironment (key input)", () => {
  it("treats blank as unassigned and folds case and whitespace", () => {
    expect(normalizeEnvironment(undefined)).toBeNull();
    expect(normalizeEnvironment(null)).toBeNull();
    expect(normalizeEnvironment("")).toBeNull();
    expect(normalizeEnvironment("   ")).toBeNull();
    expect(normalizeEnvironment("Production")).toBe("production");
    expect(normalizeEnvironment("  STAGING-eu_1 ")).toBe("staging-eu_1");
    expect(normalizeEnvironment("2026")).toBe("2026");
  });

  it("rejects malformed slugs, reserved words and non-strings with 400", () => {
    for (const bad of ["has space", "-leading", "_leading", "a".repeat(33), "prod/eu", "é"]) {
      const e = status(() => normalizeEnvironment(bad));
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_request");
    }
    expect(normalizeEnvironment("a".repeat(32))).toBe("a".repeat(32));
    expect(status(() => normalizeEnvironment(UNASSIGNED_ENVIRONMENT)).message).toContain(
      "reserved",
    );
    expect(status(() => normalizeEnvironment("ALL")).message).toContain("reserved");
    expect(status(() => normalizeEnvironment(42)).status).toBe(400);
  });
});

describe("parseEnvironmentFilter (query input)", () => {
  it("accepts slugs and the unassigned sentinel, folding case", () => {
    expect(parseEnvironmentFilter(undefined)).toBeUndefined();
    expect(parseEnvironmentFilter("")).toBeUndefined();
    expect(parseEnvironmentFilter("Preview")).toBe("preview");
    expect(parseEnvironmentFilter(" Unassigned ")).toBe(UNASSIGNED_ENVIRONMENT);
  });

  it("drops an invalid value when lenient and rejects it when strict", () => {
    expect(parseEnvironmentFilter("not valid!")).toBeUndefined();
    expect(parseEnvironmentFilter("all")).toBeUndefined();
    const e = status(() => parseEnvironmentFilter("not valid!", { strict: true }));
    expect(e.status).toBe(400);
    expect(e.message).toContain('"not valid!"');
    expect(e.message).toContain(UNASSIGNED_ENVIRONMENT);
  });

  it("maps the sentinel to the stored null and everything else to itself", () => {
    expect(storedEnvironment(UNASSIGNED_ENVIRONMENT)).toBeNull();
    expect(storedEnvironment("production")).toBe("production");
  });
});

describe("environmentFromDocument and labels", () => {
  it("only trusts well-formed slugs read back from Firestore", () => {
    expect(environmentFromDocument("production")).toBe("production");
    expect(environmentFromDocument(null)).toBeNull();
    expect(environmentFromDocument(undefined)).toBeNull();
    expect(environmentFromDocument("Production")).toBeNull();
    expect(environmentFromDocument(UNASSIGNED_ENVIRONMENT)).toBeNull();
    expect(environmentFromDocument(7)).toBeNull();
    expect(environmentLabel(null)).toBe("unassigned");
    expect(environmentLabel("qa")).toBe("qa");
  });
});

describe("dashboard selection", () => {
  it("recognises all, unassigned and slugs, and nothing else", () => {
    expect(isEnvironmentSelection(ALL_ENVIRONMENTS)).toBe(true);
    expect(isEnvironmentSelection(UNASSIGNED_ENVIRONMENT)).toBe(true);
    expect(isEnvironmentSelection("staging")).toBe(true);
    expect(isEnvironmentSelection("Staging")).toBe(false);
    expect(isEnvironmentSelection("")).toBe(false);
    expect(isEnvironmentSelection(undefined)).toBe(false);
  });

  it("defaults to production only once a key is assigned there", () => {
    expect(defaultEnvironmentSelection([])).toBe(ALL_ENVIRONMENTS);
    expect(defaultEnvironmentSelection(["preview", "development"])).toBe(ALL_ENVIRONMENTS);
    expect(defaultEnvironmentSelection(["preview", "production"])).toBe("production");
  });

  it("turns a selection into a list filter", () => {
    expect(environmentFilterOf(ALL_ENVIRONMENTS)).toBeUndefined();
    expect(environmentFilterOf(UNASSIGNED_ENVIRONMENT)).toBe(UNASSIGNED_ENVIRONMENT);
    expect(environmentFilterOf("qa")).toBe("qa");
  });

  it("sorts presets first, then alphabetically", () => {
    expect(
      ["staging", "development", "qa", "production", "preview"].sort(sortEnvironments),
    ).toEqual([...ENVIRONMENT_PRESETS, "qa", "staging"]);
  });
});

describe("per-environment rollup ids", () => {
  it("prefix the day with the environment, using a key no slug can be", () => {
    expect(envStatsKey(null)).toBe(UNASSIGNED_STATS_KEY);
    expect(envStatsKey("production")).toBe("production");
    expect(envStatsDocId("production", "2026-09-02")).toBe("production:2026-09-02");
    expect(envStatsDocId(null, "2026-09-02")).toBe("_unassigned:2026-09-02");
    // No key can be named like the unassigned bucket: slugs cannot start with "_".
    expect(() => normalizeEnvironment(UNASSIGNED_STATS_KEY)).toThrow(ApiError);
  });
});
