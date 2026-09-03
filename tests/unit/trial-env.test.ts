import { describe, expect, it } from "vitest";
import { buildServerEnv, DEFAULT_REPOSITORY_URL, trialTraceLimitFromEnv } from "@/lib/env/server";
import { isAllowedIdentity } from "@/lib/auth/session";

const base = {
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
  DASHBOARD_ALLOWED_EMAILS: "owner@example.com",
  FIRETRACE_KEY_PEPPER: "0123456789abcdef0123456789abcdef",
};

function env(extra: Record<string, string | undefined>) {
  const result = buildServerEnv({ ...base, ...extra });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.env;
}

describe("FIRETRACE_TRIAL_TRACE_LIMIT and NEXT_PUBLIC_REPOSITORY_URL", () => {
  it("defaults to trial mode off and the upstream repository", () => {
    const e = env({});
    expect(e.trialTraceLimit).toBe(0);
    expect(e.repositoryUrl).toBe(DEFAULT_REPOSITORY_URL);
  });

  it("parses a positive integer limit and a custom repository", () => {
    const e = env({
      FIRETRACE_TRIAL_TRACE_LIMIT: "5",
      NEXT_PUBLIC_REPOSITORY_URL: "https://github.com/someone/FireTrace",
    });
    expect(e.trialTraceLimit).toBe(5);
    expect(e.repositoryUrl).toBe("https://github.com/someone/FireTrace");
  });

  it("rejects negative or non-integer limits", () => {
    for (const bad of ["-1", "2.5", "abc"]) {
      const result = buildServerEnv({ ...base, FIRETRACE_TRIAL_TRACE_LIMIT: bad });
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.problems.join(" ")).toContain("FIRETRACE_TRIAL_TRACE_LIMIT");
    }
  });

  it("trialTraceLimitFromEnv never throws and treats junk as off", () => {
    expect(trialTraceLimitFromEnv(undefined)).toBe(0);
    expect(trialTraceLimitFromEnv("")).toBe(0);
    expect(trialTraceLimitFromEnv("0")).toBe(0);
    expect(trialTraceLimitFromEnv("-3")).toBe(0);
    expect(trialTraceLimitFromEnv("1.5")).toBe(0);
    expect(trialTraceLimitFromEnv("nope")).toBe(0);
    expect(trialTraceLimitFromEnv("5")).toBe(5);
  });
});

describe("isAllowedIdentity with trial mode", () => {
  const off = {
    allowedEmails: ["owner@example.com"],
    useEmulators: false,
    isProduction: true,
    trialTraceLimit: 0,
  };
  const on = { ...off, trialTraceLimit: 5 };

  it("keeps allowlisted emails as owners in both modes", () => {
    expect(isAllowedIdentity({ email: "Owner@Example.com", email_verified: true }, off)).toEqual({
      allowed: true,
      email: "owner@example.com",
      role: "owner",
    });
    expect(
      isAllowedIdentity({ email: "owner@example.com", email_verified: true }, on),
    ).toMatchObject({
      role: "owner",
    });
  });

  it("admits other verified accounts as trial users only when the limit is positive", () => {
    expect(
      isAllowedIdentity({ email: "guest@example.com", email_verified: true }, off),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("not in the dashboard allowlist"),
    });
    expect(isAllowedIdentity({ email: "guest@example.com", email_verified: true }, on)).toEqual({
      allowed: true,
      email: "guest@example.com",
      role: "trial",
    });
  });

  it("still requires a verified email for trial users", () => {
    expect(
      isAllowedIdentity({ email: "guest@example.com", email_verified: false }, on),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/verify the email/i),
    });
  });
});
