import { cookies } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/lib/env/server";
import { ApiError } from "@/lib/firetrace/errors";
import {
  createSessionCookie,
  getOwner,
  isAllowedIdentity,
  NotAllowedError,
  requireOwner,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieOptions,
  verifySessionCookieValue,
} from "@/lib/auth/session";

const state = vi.hoisted(() => ({
  env: {
    nodeEnv: "test",
    isProduction: false,
    projectId: "demo-firetrace",
    serviceAccountBase64: null,
    allowedEmails: ["owner@example.com"],
    keyPepper: "0123456789abcdef0123456789abcdef",
    appUrl: "http://localhost:3000",
    storageLimitBytes: 1024 * 1024 * 1024,
    useEmulators: false,
    authEmulatorHost: "127.0.0.1:9099",
    firestoreEmulatorHost: "127.0.0.1:8080",
  } as ServerEnv,
  auth: {
    verifyIdToken: vi.fn(),
    verifySessionCookie: vi.fn(),
    createSessionCookie: vi.fn(),
  },
}));

vi.mock("@/lib/env/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env/server")>();
  return { ...actual, serverEnv: () => state.env };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminApp: () => {
    throw new Error("adminApp must not be used in unit tests");
  },
  adminDb: () => {
    throw new Error("adminDb must not be used in unit tests");
  },
  adminAuth: () => state.auth,
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const baseEnv = { allowedEmails: ["owner@example.com"], useEmulators: false, isProduction: true };

const decoded = (overrides: Record<string, unknown> = {}) => ({
  uid: "uid-1",
  email: "owner@example.com",
  email_verified: true,
  name: "Owner",
  picture: "https://example.com/avatar.png",
  ...overrides,
});

function mockCookieStore(value: string | undefined) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name === SESSION_COOKIE && value ? { name, value } : undefined),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.env = {
    ...state.env,
    allowedEmails: ["owner@example.com"],
    useEmulators: false,
    isProduction: false,
  };
});

describe("isAllowedIdentity", () => {
  it("allows a verified, allowlisted email", () => {
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: true }, baseEnv),
    ).toEqual({
      allowed: true,
      email: "owner@example.com",
    });
  });

  it("matches emails case-insensitively and trims whitespace", () => {
    expect(
      isAllowedIdentity({ email: "  Owner@Example.COM ", email_verified: true }, baseEnv),
    ).toEqual({ allowed: true, email: "owner@example.com" });
    expect(
      isAllowedIdentity(
        { email: "owner@example.com", email_verified: true },
        { ...baseEnv, allowedEmails: ["owner@example.com", "second@example.com"] },
      ).allowed,
    ).toBe(true);
  });

  it("rejects an unverified email even when allowlisted", () => {
    const decision = isAllowedIdentity(
      { email: "owner@example.com", email_verified: false },
      baseEnv,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toMatch(/verify/i);
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: undefined }, baseEnv).allowed,
    ).toBe(false);
  });

  it("rejects an email that is not allowlisted", () => {
    const decision = isAllowedIdentity(
      { email: "intruder@example.com", email_verified: true },
      baseEnv,
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toContain("intruder@example.com");
    expect(decision.reason).toContain("allowlist");
  });

  it("rejects tokens without an email", () => {
    for (const email of [undefined, "", "   "]) {
      const decision = isAllowedIdentity({ email, email_verified: true }, baseEnv);
      expect(decision.allowed).toBe(false);
      if (decision.allowed) return;
      expect(decision.reason).toContain("no email");
    }
  });

  it("rejects everyone when the allowlist is empty outside emulator mode", () => {
    const env = { allowedEmails: [], useEmulators: false, isProduction: false };
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: true }, env).allowed,
    ).toBe(false);
  });

  it("bypasses the allowlist only for emulators with an empty allowlist outside production", () => {
    const bypass = { allowedEmails: [], useEmulators: true, isProduction: false };
    expect(isAllowedIdentity({ email: "Dev@Example.com", email_verified: false }, bypass)).toEqual({
      allowed: true,
      email: "dev@example.com",
    });

    const withList = {
      allowedEmails: ["owner@example.com"],
      useEmulators: true,
      isProduction: false,
    };
    expect(
      isAllowedIdentity({ email: "dev@example.com", email_verified: true }, withList).allowed,
    ).toBe(false);
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: false }, withList).allowed,
    ).toBe(false);
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: true }, withList).allowed,
    ).toBe(true);

    const production = { allowedEmails: [], useEmulators: true, isProduction: true };
    expect(
      isAllowedIdentity({ email: "dev@example.com", email_verified: true }, production).allowed,
    ).toBe(false);
    expect(isAllowedIdentity({ email: undefined, email_verified: true }, bypass).allowed).toBe(
      false,
    );
  });
});

describe("sessionCookieOptions", () => {
  it("is HTTP-only, lax, scoped to the site, and bounded to five days", () => {
    const options = sessionCookieOptions(state.env);
    expect(options).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 5 * 24 * 60 * 60,
    });
    expect(SESSION_TTL_MS).toBe(5 * 24 * 60 * 60 * 1000);
    expect(SESSION_COOKIE).toBe("firetrace_session");
  });

  it("is secure in production or behind https", () => {
    expect(sessionCookieOptions({ ...state.env, isProduction: true }).secure).toBe(true);
    expect(
      sessionCookieOptions({ ...state.env, appUrl: "https://firetrace.example.com" }).secure,
    ).toBe(true);
  });
});

describe("createSessionCookie", () => {
  it("verifies the id token, checks the allowlist, and mints a cookie", async () => {
    state.auth.verifyIdToken.mockResolvedValue(decoded({ email: "Owner@Example.com" }));
    state.auth.createSessionCookie.mockResolvedValue("session-cookie-value");
    const result = await createSessionCookie("id-token");
    expect(result).toEqual({
      cookie: "session-cookie-value",
      owner: {
        uid: "uid-1",
        email: "owner@example.com",
        name: "Owner",
        picture: "https://example.com/avatar.png",
      },
    });
    expect(state.auth.verifyIdToken).toHaveBeenCalledWith("id-token", true);
    expect(state.auth.createSessionCookie).toHaveBeenCalledWith("id-token", {
      expiresIn: SESSION_TTL_MS,
    });
  });

  it("throws NotAllowedError (403 forbidden) for a disallowed identity without minting a cookie", async () => {
    state.auth.verifyIdToken.mockResolvedValue(decoded({ email: "intruder@example.com" }));
    const promise = createSessionCookie("id-token");
    await expect(promise).rejects.toBeInstanceOf(NotAllowedError);
    await expect(promise).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(state.auth.createSessionCookie).not.toHaveBeenCalled();
  });

  it("maps token verification failures to a sanitized 401 without minting a cookie", async () => {
    state.auth.verifyIdToken.mockRejectedValue(new Error("auth/id-token-expired: internal detail"));
    const promise = createSessionCookie("stale");
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(promise).rejects.not.toThrow(/internal detail/);
    expect(state.auth.createSessionCookie).not.toHaveBeenCalled();
  });

  it("omits name and picture when the token lacks them", async () => {
    state.auth.verifyIdToken.mockResolvedValue(decoded({ name: undefined, picture: 42 }));
    state.auth.createSessionCookie.mockResolvedValue("cookie");
    const { owner } = await createSessionCookie("id-token");
    expect(owner.name).toBeNull();
    expect(owner.picture).toBeNull();
  });
});

describe("verifySessionCookieValue", () => {
  it("returns null without touching Firebase when the cookie is missing", async () => {
    expect(await verifySessionCookieValue(undefined)).toBeNull();
    expect(await verifySessionCookieValue("")).toBeNull();
    expect(state.auth.verifySessionCookie).not.toHaveBeenCalled();
  });

  it("returns the owner for a valid cookie and checks revocation", async () => {
    state.auth.verifySessionCookie.mockResolvedValue(decoded());
    const owner = await verifySessionCookieValue("cookie");
    expect(owner).toEqual({
      uid: "uid-1",
      email: "owner@example.com",
      name: "Owner",
      picture: "https://example.com/avatar.png",
    });
    expect(state.auth.verifySessionCookie).toHaveBeenCalledWith("cookie", true);
  });

  it("returns null when verification throws", async () => {
    state.auth.verifySessionCookie.mockRejectedValue(new Error("auth/session-cookie-revoked"));
    expect(await verifySessionCookieValue("cookie")).toBeNull();
  });

  it("re-checks the allowlist on every read", async () => {
    state.auth.verifySessionCookie.mockResolvedValue(decoded());
    state.env = { ...state.env, allowedEmails: ["someone-else@example.com"] };
    expect(await verifySessionCookieValue("cookie")).toBeNull();
    state.auth.verifySessionCookie.mockResolvedValue(decoded({ email_verified: false }));
    state.env = { ...state.env, allowedEmails: ["owner@example.com"] };
    expect(await verifySessionCookieValue("cookie")).toBeNull();
  });
});

describe("getOwner and requireOwner", () => {
  it("reads the session cookie from the request", async () => {
    mockCookieStore("cookie");
    state.auth.verifySessionCookie.mockResolvedValue(decoded());
    const owner = await getOwner();
    expect(owner?.email).toBe("owner@example.com");
    expect(await requireOwner()).toEqual(owner);
  });

  it("returns null or throws 401 when there is no valid session", async () => {
    mockCookieStore(undefined);
    expect(await getOwner()).toBeNull();
    const promise = requireOwner();
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(state.auth.verifySessionCookie).not.toHaveBeenCalled();
  });
});
