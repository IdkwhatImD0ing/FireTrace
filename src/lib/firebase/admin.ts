import "server-only";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { decodeServiceAccount, serverEnv } from "@/lib/env/server";

/**
 * Firebase Admin SDK, initialized exactly once per process (survives Next.js
 * hot reloads and reused serverless instances via a global slot). The Admin
 * SDK bypasses Firestore rules: every caller must authorize first.
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_BASE64 (decoded in memory), else
 * Application Default Credentials for local development. With
 * FIRETRACE_USE_EMULATORS=true the SDK is pointed at the local emulators and
 * needs no credentials.
 */
const slot = globalThis as unknown as { __firetraceAdminApp?: App };

export function adminApp(): App {
  if (slot.__firetraceAdminApp) return slot.__firetraceAdminApp;
  const existing = getApps().find((a) => a.name === "[DEFAULT]");
  if (existing) {
    slot.__firetraceAdminApp = existing;
    return existing;
  }

  const env = serverEnv();
  let app: App;
  if (env.useEmulators) {
    process.env.FIRESTORE_EMULATOR_HOST = env.firestoreEmulatorHost;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = env.authEmulatorHost;
    app = initializeApp({ projectId: env.projectId });
  } else if (env.serviceAccountBase64) {
    // The Admin SDK silently targets an emulator whenever these are set; only
    // FIRETRACE_USE_EMULATORS may opt in, so stray host variables are ignored.
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const decoded = decodeServiceAccount(env.serviceAccountBase64);
    if (!decoded.ok) throw new Error(decoded.problem);
    app = initializeApp({
      credential: cert(decoded.json as ServiceAccount),
      projectId: env.projectId,
    });
  } else {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    app = initializeApp({ credential: applicationDefault(), projectId: env.projectId });
  }
  slot.__firetraceAdminApp = app;
  return app;
}

export function adminDb(): Firestore {
  return getFirestore(adminApp());
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}
