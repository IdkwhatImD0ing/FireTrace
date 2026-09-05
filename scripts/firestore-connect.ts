import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Firestore for one-off scripts: same credential order as
 * src/lib/firebase/admin.ts, without the server-only import. Targets the
 * emulator only when FIRETRACE_USE_EMULATORS=true.
 */
export function connectFirestore(): Firestore {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("NEXT_PUBLIC_FIREBASE_PROJECT_ID is required.");
  if (getApps().length === 0) {
    if (process.env.FIRETRACE_USE_EMULATORS === "true") {
      process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
      initializeApp({ projectId });
    } else {
      // The Admin SDK silently targets an emulator whenever this is set.
      delete process.env.FIRESTORE_EMULATOR_HOST;
      const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
      if (base64) {
        const json = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as ServiceAccount;
        initializeApp({ credential: cert(json), projectId });
      } else {
        // Application Default Credentials (gcloud auth application-default login).
        initializeApp({ projectId });
      }
    }
  }
  return getFirestore();
}
