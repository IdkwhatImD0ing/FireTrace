import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { clientEnv } from "@/lib/env/client";

/**
 * Firebase Web SDK, used in the browser for sign-in only. Application data
 * never flows through this client; Firestore rules deny all direct access.
 */
let cachedAuth: Auth | null = null;

export function firebaseClientAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  const env = clientEnv();
  if (!env) return null;

  const app: FirebaseApp =
    getApps().length > 0
      ? getApp()
      : initializeApp({
          apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
          authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
          projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
        });
  const auth = getAuth(app);
  if (env.NEXT_PUBLIC_FIRETRACE_USE_EMULATORS === "true") {
    const flag = globalThis as { __firetraceAuthEmulator?: boolean };
    if (!flag.__firetraceAuthEmulator) {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      flag.__firetraceAuthEmulator = true;
    }
  }
  cachedAuth = auth;
  return auth;
}
