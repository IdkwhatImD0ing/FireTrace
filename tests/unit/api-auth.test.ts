import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { keyIsUsable, requireScope, type AuthenticatedKey } from "@/lib/firetrace/api-auth";
import { ApiError } from "@/lib/firetrace/errors";

const NOW = Date.UTC(2026, 8, 3, 12);

describe("keyIsUsable", () => {
  it("accepts keys that are neither revoked nor expired", () => {
    expect(keyIsUsable({}, NOW)).toBe(true);
    expect(keyIsUsable({ revokedAt: null, expiresAt: null }, NOW)).toBe(true);
    expect(keyIsUsable({ expiresAt: Timestamp.fromMillis(NOW + 1) }, NOW)).toBe(true);
    expect(keyIsUsable({ expiresAt: new Date(NOW + 60_000) }, NOW)).toBe(true);
  });

  it("rejects revoked keys regardless of expiry", () => {
    expect(keyIsUsable({ revokedAt: Timestamp.fromMillis(NOW - 1) }, NOW)).toBe(false);
    expect(keyIsUsable({ revokedAt: new Date(NOW), expiresAt: null }, NOW)).toBe(false);
  });

  it("rejects keys at or past their expiry as Timestamp or Date", () => {
    expect(keyIsUsable({ expiresAt: Timestamp.fromMillis(NOW) }, NOW)).toBe(false);
    expect(keyIsUsable({ expiresAt: Timestamp.fromMillis(NOW - 1) }, NOW)).toBe(false);
    expect(keyIsUsable({ expiresAt: new Date(NOW - 1) }, NOW)).toBe(false);
  });

  it("ignores expiry values of unexpected types instead of locking everyone out", () => {
    expect(keyIsUsable({ expiresAt: "2020-01-01" }, NOW)).toBe(true);
    expect(keyIsUsable({ expiresAt: 0 }, NOW)).toBe(true);
  });
});

describe("requireScope", () => {
  const auth: AuthenticatedKey = {
    keyId: "0123456789abcdef",
    projectId: "p1",
    scopes: ["traces:write"],
    expiresAt: null,
    lastUsedAt: null,
    plan: "owner",
    environment: null,
  };

  it("passes when the scope is present and throws 403 insufficient_scope otherwise", () => {
    expect(() => requireScope(auth, "traces:write")).not.toThrow();
    try {
      requireScope(auth, "traces:delete");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).code).toBe("insufficient_scope");
      expect((err as ApiError).message).toContain("traces:delete");
    }
  });
});
