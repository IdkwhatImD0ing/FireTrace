import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServerEnv, ConfigError, parseAllowedEmails } from "@/lib/env/server";

const PEPPER = "0123456789abcdef0123456789abcdef-unit-test";
const SERVICE_ACCOUNT_BASE64 = Buffer.from(
  JSON.stringify({
    type: "service_account",
    project_id: "demo-firetrace",
    client_email: "firetrace@demo-firetrace.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
  }),
  "utf8",
).toString("base64");

const development: Record<string, string | undefined> = {
  NODE_ENV: "development",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
  DASHBOARD_ALLOWED_EMAILS: "Owner@Example.com",
  FIRETRACE_KEY_PEPPER: PEPPER,
};

const production: Record<string, string | undefined> = {
  NODE_ENV: "production",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
  FIREBASE_SERVICE_ACCOUNT_BASE64: SERVICE_ACCOUNT_BASE64,
  DASHBOARD_ALLOWED_EMAILS: "owner@example.com",
  FIRETRACE_KEY_PEPPER: PEPPER,
  NEXT_PUBLIC_APP_URL: "https://firetrace.example.com",
};

function ok(raw: Record<string, string | undefined>) {
  const result = buildServerEnv(raw);
  if (!result.ok) throw new Error(`expected valid env, got: ${result.problems.join("; ")}`);
  return result.env;
}

function problems(raw: Record<string, string | undefined>): string[] {
  const result = buildServerEnv(raw);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

describe("parseAllowedEmails", () => {
  it("splits on commas, trims, lowercases, and drops blanks", () => {
    expect(parseAllowedEmails("")).toEqual([]);
    expect(parseAllowedEmails(" , ,")).toEqual([]);
    expect(parseAllowedEmails("A@Example.com, b@example.com ,,C@EXAMPLE.COM")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
});

describe("buildServerEnv", () => {
  it("accepts a development configuration and applies defaults", () => {
    const env = ok(development);
    expect(env).toEqual({
      nodeEnv: "development",
      isProduction: false,
      projectId: "demo-firetrace",
      serviceAccountBase64: null,
      allowedEmails: ["owner@example.com"],
      keyPepper: PEPPER,
      appUrl: "http://localhost:3000",
      storageLimitBytes: 1024 * 1024 * 1024,
      useEmulators: false,
      authEmulatorHost: "127.0.0.1:9099",
      firestoreEmulatorHost: "127.0.0.1:8080",
    });
  });

  it("accepts a complete production configuration", () => {
    const env = ok(production);
    expect(env.isProduction).toBe(true);
    expect(env.nodeEnv).toBe("production");
    expect(env.serviceAccountBase64).toBe(SERVICE_ACCOUNT_BASE64);
    expect(env.appUrl).toBe("https://firetrace.example.com");
    expect(env.useEmulators).toBe(false);
  });

  it("defaults NODE_ENV to development and treats test as non-production", () => {
    expect(ok({ ...development, NODE_ENV: undefined }).nodeEnv).toBe("development");
    const env = ok({ ...development, NODE_ENV: "test" });
    expect(env.nodeEnv).toBe("test");
    expect(env.isProduction).toBe(false);
    expect(problems({ ...development, NODE_ENV: "staging" })[0]).toContain("NODE_ENV");
  });

  it("fails closed in production without an email allowlist", () => {
    for (const value of [undefined, "", " , "]) {
      const list = problems({ ...production, DASHBOARD_ALLOWED_EMAILS: value });
      expect(list).toHaveLength(1);
      expect(list[0]).toContain("DASHBOARD_ALLOWED_EMAILS");
      expect(list[0]).toContain("production");
    }
  });

  it("requires Admin credentials in production", () => {
    const list = problems({ ...production, FIREBASE_SERVICE_ACCOUNT_BASE64: undefined });
    expect(list).toEqual(["FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production"]);
    expect(problems({ ...production, FIREBASE_SERVICE_ACCOUNT_BASE64: "   " })).toEqual([
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production",
    ]);
  });

  it("rejects emulators in production", () => {
    const list = problems({ ...production, FIRETRACE_USE_EMULATORS: "true" });
    expect(list).toEqual(["FIRETRACE_USE_EMULATORS must not be enabled in production"]);
  });

  it("requires a pepper of at least 32 characters everywhere", () => {
    expect(problems({ ...development, FIRETRACE_KEY_PEPPER: undefined })).toEqual([
      "FIRETRACE_KEY_PEPPER must be set to a random string of at least 32 characters",
    ]);
    expect(problems({ ...development, FIRETRACE_KEY_PEPPER: "" })).toHaveLength(1);
    expect(problems({ ...development, FIRETRACE_KEY_PEPPER: "x".repeat(31) })).toHaveLength(1);
    expect(problems({ ...development, FIRETRACE_KEY_PEPPER: `${"x".repeat(31)} ` })).toHaveLength(
      1,
    );
    expect(ok({ ...development, FIRETRACE_KEY_PEPPER: "x".repeat(32) }).keyPepper).toBe(
      "x".repeat(32),
    );
    expect(ok({ ...development, FIRETRACE_KEY_PEPPER: `  ${PEPPER}  ` }).keyPepper).toBe(PEPPER);
    expect(problems({ ...production, FIRETRACE_KEY_PEPPER: undefined })).toEqual([
      "FIRETRACE_KEY_PEPPER must be set to a random string of at least 32 characters",
    ]);
  });

  it("allows an empty allowlist in development only when emulators are enabled", () => {
    const env = ok({
      ...development,
      DASHBOARD_ALLOWED_EMAILS: undefined,
      FIRETRACE_USE_EMULATORS: "true",
    });
    expect(env.useEmulators).toBe(true);
    expect(env.allowedEmails).toEqual([]);
    expect(env.serviceAccountBase64).toBeNull();

    const list = problems({ ...development, DASHBOARD_ALLOWED_EMAILS: undefined });
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("DASHBOARD_ALLOWED_EMAILS is empty");
    expect(list[0]).toContain("FIRETRACE_USE_EMULATORS");
  });

  it("uses custom emulator hosts when provided", () => {
    const env = ok({
      ...development,
      FIRETRACE_USE_EMULATORS: "true",
      FIREBASE_AUTH_EMULATOR_HOST: "localhost:9199",
      FIRESTORE_EMULATOR_HOST: "localhost:8180",
    });
    expect(env.authEmulatorHost).toBe("localhost:9199");
    expect(env.firestoreEmulatorHost).toBe("localhost:8180");
  });

  it("only accepts the literal strings true and false for the emulator flag", () => {
    expect(ok({ ...development, FIRETRACE_USE_EMULATORS: "false" }).useEmulators).toBe(false);
    expect(problems({ ...development, FIRETRACE_USE_EMULATORS: "yes" })[0]).toContain(
      "FIRETRACE_USE_EMULATORS",
    );
    expect(problems({ ...development, FIRETRACE_USE_EMULATORS: "TRUE" })[0]).toContain(
      "FIRETRACE_USE_EMULATORS",
    );
  });

  it("rejects service-account values that are not base64 JSON", () => {
    expect(problems({ ...development, FIREBASE_SERVICE_ACCOUNT_BASE64: "!!!!" })).toEqual([
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64 JSON",
    ]);
    expect(
      problems({
        ...development,
        FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from("not json").toString("base64"),
      }),
    ).toEqual(["FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64 JSON"]);
  });

  it("rejects base64 JSON that is not a service account", () => {
    for (const value of ['{"type":"user"}', "[]", "null", '"service_account"', "42"]) {
      expect(
        problems({
          ...development,
          FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(value).toString("base64"),
        }),
      ).toEqual(["FIREBASE_SERVICE_ACCOUNT_BASE64 does not decode to a service-account JSON"]);
    }
  });

  it("accepts a valid service account outside production", () => {
    const env = ok({ ...development, FIREBASE_SERVICE_ACCOUNT_BASE64: SERVICE_ACCOUNT_BASE64 });
    expect(env.serviceAccountBase64).toBe(SERVICE_ACCOUNT_BASE64);
  });

  it("normalizes NEXT_PUBLIC_APP_URL to its origin", () => {
    expect(ok({ ...development, NEXT_PUBLIC_APP_URL: "https://Fire.Example.com/" }).appUrl).toBe(
      "https://fire.example.com",
    );
    expect(
      ok({ ...development, NEXT_PUBLIC_APP_URL: "https://fire.example.com/dashboard/?x=1#y" })
        .appUrl,
    ).toBe("https://fire.example.com");
    expect(ok({ ...development, NEXT_PUBLIC_APP_URL: "http://localhost:3000///" }).appUrl).toBe(
      "http://localhost:3000",
    );
    expect(ok({ ...development, NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3001" }).appUrl).toBe(
      "http://127.0.0.1:3001",
    );
  });

  it("rejects a relative or empty NEXT_PUBLIC_APP_URL", () => {
    for (const value of ["", "fire.example.com", "/dashboard", "not a url"]) {
      expect(problems({ ...development, NEXT_PUBLIC_APP_URL: value })).toEqual([
        "NEXT_PUBLIC_APP_URL must be an absolute URL",
      ]);
    }
  });

  it("coerces the storage limit and rejects non-positive or non-numeric values", () => {
    expect(ok({ ...development, FIRETRACE_STORAGE_LIMIT_BYTES: "2048" }).storageLimitBytes).toBe(
      2048,
    );
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(problems({ ...development, FIRETRACE_STORAGE_LIMIT_BYTES: value })[0]).toContain(
        "FIRETRACE_STORAGE_LIMIT_BYTES",
      );
    }
  });

  it("requires the Firebase project id", () => {
    expect(problems({ ...development, NEXT_PUBLIC_FIREBASE_PROJECT_ID: undefined })[0]).toContain(
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    );
    expect(problems({ ...development, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "" })[0]).toContain(
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    );
  });

  it("reports every problem at once", () => {
    const list = problems({
      NODE_ENV: "production",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
      FIRETRACE_USE_EMULATORS: "true",
      NEXT_PUBLIC_APP_URL: "nope",
    });
    expect(list).toEqual([
      "FIRETRACE_USE_EMULATORS must not be enabled in production",
      "DASHBOARD_ALLOWED_EMAILS must list at least one email in production",
      "FIRETRACE_KEY_PEPPER must be set to a random string of at least 32 characters",
      "FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production",
      "NEXT_PUBLIC_APP_URL must be an absolute URL",
    ]);
  });

  it("never echoes secret values in problems", () => {
    const list = problems({
      ...production,
      FIREBASE_SERVICE_ACCOUNT_BASE64: "!!!!",
      FIRETRACE_KEY_PEPPER: "short",
    });
    expect(list.join(" ")).not.toContain("short");
    expect(list.join(" ")).not.toContain("!!!!");
  });
});

describe("ConfigError", () => {
  it("carries the problem list in its message", () => {
    const error = new ConfigError(["a is missing", "b is bad"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConfigError");
    expect(error.problems).toEqual(["a is missing", "b is bad"]);
    expect(error.message).toBe("FireTrace is not configured: a is missing; b is bad");
  });
});

describe("serverEnv and configStatus", () => {
  const KEYS = [
    "NODE_ENV",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "FIREBASE_SERVICE_ACCOUNT_BASE64",
    "DASHBOARD_ALLOWED_EMAILS",
    "FIRETRACE_KEY_PEPPER",
    "NEXT_PUBLIC_APP_URL",
    "FIRETRACE_STORAGE_LIMIT_BYTES",
    "FIRETRACE_USE_EMULATORS",
    "FIREBASE_AUTH_EMULATOR_HOST",
    "FIRESTORE_EMULATOR_HOST",
  ] as const;

  function stubProcessEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
    for (const key of KEYS) vi.stubEnv(key, values[key]);
  }

  async function freshModule() {
    vi.resetModules();
    return import("@/lib/env/server");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws ConfigError and reports booleans when production is misconfigured", async () => {
    stubProcessEnv({ NODE_ENV: "production", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace" });
    const mod = await freshModule();
    expect(() => mod.serverEnv()).toThrow(mod.ConfigError);
    expect(() => mod.serverEnv()).toThrow(/DASHBOARD_ALLOWED_EMAILS/);
    const status = mod.configStatus();
    expect(status).toEqual({
      firebaseConfigured: false,
      authConfigured: false,
      ingestConfigured: false,
      emulators: false,
      problems: [
        "DASHBOARD_ALLOWED_EMAILS must list at least one email in production",
        "FIRETRACE_KEY_PEPPER must be set to a random string of at least 32 characters",
        "FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production",
      ],
    });
  });

  it("reports the schema failure when the project id is missing", async () => {
    stubProcessEnv({ NODE_ENV: "development", FIRETRACE_KEY_PEPPER: PEPPER });
    const mod = await freshModule();
    const status = mod.configStatus();
    expect(status.firebaseConfigured).toBe(false);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toContain("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  });

  it("reports partial configuration precisely", async () => {
    stubProcessEnv({
      NODE_ENV: "production",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
      FIREBASE_SERVICE_ACCOUNT_BASE64: SERVICE_ACCOUNT_BASE64,
      FIRETRACE_KEY_PEPPER: PEPPER,
      NEXT_PUBLIC_APP_URL: "https://firetrace.example.com",
    });
    const mod = await freshModule();
    const status = mod.configStatus();
    expect(status.firebaseConfigured).toBe(true);
    expect(status.ingestConfigured).toBe(true);
    expect(status.authConfigured).toBe(false);
    expect(status.problems).toEqual([
      "DASHBOARD_ALLOWED_EMAILS must list at least one email in production",
    ]);
  });

  it("returns a cached env when configured", async () => {
    stubProcessEnv({
      NODE_ENV: "development",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-firetrace",
      FIRETRACE_USE_EMULATORS: "true",
      FIRETRACE_KEY_PEPPER: PEPPER,
    });
    const mod = await freshModule();
    const first = mod.serverEnv();
    expect(first.projectId).toBe("demo-firetrace");
    expect(first.useEmulators).toBe(true);
    expect(first.allowedEmails).toEqual([]);
    expect(mod.serverEnv()).toBe(first);
    expect(mod.configStatus()).toEqual({
      firebaseConfigured: true,
      authConfigured: true,
      ingestConfigured: true,
      emulators: true,
      problems: [],
    });
  });
});
