import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  AUTH_EMULATOR_HOST,
  E2E_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST,
  OUTSIDER,
  OWNER,
} from "./accounts";

/**
 * Runs once before the browser tests, after playwright.config.ts has started
 * the emulators and the dev server. Resets both emulators and seeds two
 * verified email/password accounts: the allowlisted owner and an outsider.
 */
async function waitForHttp(url: string, label: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready at ${url} (${lastError})`);
}

async function del(url: string, label: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to reset ${label}: HTTP ${res.status}`);
}

export default async function globalSetup(): Promise<void> {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR_HOST;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  await waitForHttp(`http://${AUTH_EMULATOR_HOST}/`, "Auth emulator");
  await waitForHttp(`http://${FIRESTORE_EMULATOR_HOST}/`, "Firestore emulator");

  await del(
    `http://${FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${E2E_PROJECT_ID}/databases/(default)/documents`,
    "Firestore emulator documents",
  );
  await del(
    `http://${AUTH_EMULATOR_HOST}/emulator/v1/projects/${E2E_PROJECT_ID}/accounts`,
    "Auth emulator accounts",
  );

  const app = getApps()[0] ?? initializeApp({ projectId: E2E_PROJECT_ID });
  const auth = getAuth(app);
  for (const account of [OWNER, OUTSIDER]) {
    await auth.createUser({
      email: account.email,
      password: account.password,
      emailVerified: true,
      displayName: account.name,
    });
  }
  await deleteApp(app);
}
