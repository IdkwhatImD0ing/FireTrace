import "server-only";
import { z } from "zod";

/**
 * Server-only configuration. Parsed once per process. Production fails closed:
 * missing Admin credentials, pepper, or allowlist make `serverEnv()` throw a
 * ConfigError, and `configStatus()` reports booleans for the health endpoint.
 */
const GIB = 1024 * 1024 * 1024;

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().trim().optional(),
  DASHBOARD_ALLOWED_EMAILS: z.string().default(""),
  FIRETRACE_KEY_PEPPER: z.string().trim().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  FIRETRACE_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().default(GIB),
  FIRETRACE_USE_EMULATORS: z.enum(["true", "false"]).default("false"),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
});

export interface ServerEnv {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  projectId: string;
  serviceAccountBase64: string | null;
  allowedEmails: string[];
  keyPepper: string;
  appUrl: string;
  storageLimitBytes: number;
  useEmulators: boolean;
  authEmulatorHost: string;
  firestoreEmulatorHost: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`FireTrace is not configured: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function parseAllowedEmails(value: string): string[] {
  return value
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** Pure: turn raw env into a typed config or a list of problems. Exported for tests. */
export function buildServerEnv(
  raw: Record<string, string | undefined>,
): { ok: true; env: ServerEnv } | { ok: false; problems: string[] } {
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const v = parsed.data;
  const isProduction = v.NODE_ENV === "production";
  const useEmulators = v.FIRETRACE_USE_EMULATORS === "true";
  const allowedEmails = parseAllowedEmails(v.DASHBOARD_ALLOWED_EMAILS);
  const problems: string[] = [];

  if (isProduction && useEmulators) {
    problems.push("FIRETRACE_USE_EMULATORS must not be enabled in production");
  }
  if (isProduction && allowedEmails.length === 0) {
    problems.push("DASHBOARD_ALLOWED_EMAILS must list at least one email in production");
  }
  if (!useEmulators && allowedEmails.length === 0 && !isProduction) {
    // Development without emulators still needs an owner to let anyone in.
    problems.push("DASHBOARD_ALLOWED_EMAILS is empty (set it, or enable FIRETRACE_USE_EMULATORS)");
  }
  if (!v.FIRETRACE_KEY_PEPPER || v.FIRETRACE_KEY_PEPPER.length < 32) {
    problems.push("FIRETRACE_KEY_PEPPER must be set to a random string of at least 32 characters");
  }
  if (isProduction && !v.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    problems.push("FIREBASE_SERVICE_ACCOUNT_BASE64 is required in production");
  }
  if (v.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const json = JSON.parse(
        Buffer.from(v.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"),
      );
      if (typeof json !== "object" || json === null || json.type !== "service_account") {
        problems.push("FIREBASE_SERVICE_ACCOUNT_BASE64 does not decode to a service-account JSON");
      }
    } catch {
      problems.push("FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64 JSON");
    }
  }
  let appUrl = v.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  try {
    appUrl = new URL(appUrl).origin;
  } catch {
    problems.push("NEXT_PUBLIC_APP_URL must be an absolute URL");
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    env: {
      nodeEnv: v.NODE_ENV,
      isProduction,
      projectId: v.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      serviceAccountBase64: v.FIREBASE_SERVICE_ACCOUNT_BASE64 || null,
      allowedEmails,
      keyPepper: v.FIRETRACE_KEY_PEPPER as string,
      appUrl,
      storageLimitBytes: v.FIRETRACE_STORAGE_LIMIT_BYTES,
      useEmulators,
      authEmulatorHost: v.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099",
      firestoreEmulatorHost: v.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080",
    },
  };
}

let cached: ServerEnv | undefined;

/** Typed server config. Throws ConfigError when the deployment is misconfigured. */
export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const result = buildServerEnv(process.env);
  if (!result.ok) throw new ConfigError(result.problems);
  cached = result.env;
  return cached;
}

/** Boolean-only view for the health endpoint. Never includes values. */
export function configStatus(): {
  firebaseConfigured: boolean;
  authConfigured: boolean;
  ingestConfigured: boolean;
  emulators: boolean;
  problems: string[];
} {
  const result = buildServerEnv(process.env);
  const emulators = process.env.FIRETRACE_USE_EMULATORS === "true";
  if (result.ok) {
    return {
      firebaseConfigured: true,
      authConfigured: true,
      ingestConfigured: true,
      emulators,
      problems: [],
    };
  }
  const p = result.problems;
  return {
    firebaseConfigured: !p.some(
      (m) => m.includes("FIREBASE_SERVICE_ACCOUNT") || m.includes("PROJECT_ID"),
    ),
    authConfigured: !p.some((m) => m.includes("DASHBOARD_ALLOWED_EMAILS")),
    ingestConfigured: !p.some((m) => m.includes("FIRETRACE_KEY_PEPPER")),
    emulators,
    problems: p,
  };
}
