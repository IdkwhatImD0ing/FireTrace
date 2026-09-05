import { describe, expect, it } from "vitest";
import { requireTrialModeForKey, type AuthenticatedKey } from "@/lib/firetrace/api-auth";
import { ApiError } from "@/lib/firetrace/errors";

const base: AuthenticatedKey = {
  keyId: "0123456789abcdef",
  projectId: "p1",
  scopes: ["traces:write", "traces:read"],
  expiresAt: null,
  lastUsedAt: null,
  plan: "owner",
  environment: null,
};

describe("requireTrialModeForKey", () => {
  it("never touches owner keys", () => {
    expect(() => requireTrialModeForKey(base, 0)).not.toThrow();
    expect(() => requireTrialModeForKey(base, 5)).not.toThrow();
  });

  it("accepts trial keys while trial mode is on and rejects them once it is off", () => {
    const trial: AuthenticatedKey = { ...base, plan: "trial" };
    expect(() => requireTrialModeForKey(trial, 5)).not.toThrow();
    try {
      requireTrialModeForKey(trial, 0);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).code).toBe("invalid_api_key");
      expect((err as ApiError).message).toContain("switched off");
    }
  });
});
