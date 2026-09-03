import { z } from "zod";

/**
 * Browser-safe configuration. Only NEXT_PUBLIC_* values are referenced here,
 * each by its literal name so Next.js can inline them at build time.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1, "NEXT_PUBLIC_FIREBASE_API_KEY is required"),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z
    .string()
    .min(1, "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN is required"),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1, "NEXT_PUBLIC_FIREBASE_PROJECT_ID is required"),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1, "NEXT_PUBLIC_FIREBASE_APP_ID is required"),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_FIRETRACE_USE_EMULATORS: z.enum(["true", "false"]).default("false"),
});

export type ClientEnv = z.infer<typeof clientSchema>;

const raw = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_FIRETRACE_USE_EMULATORS: process.env.NEXT_PUBLIC_FIRETRACE_USE_EMULATORS,
};

let cached: ClientEnv | null | undefined;

/** Parsed client env, or null when the Firebase Web app config is incomplete. */
export function clientEnv(): ClientEnv | null {
  if (cached !== undefined) return cached;
  const parsed = clientSchema.safeParse(raw);
  cached = parsed.success ? parsed.data : null;
  return cached;
}

export function clientEnvProblems(): string[] {
  const parsed = clientSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}
