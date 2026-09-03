import { defineConfig, devices } from "@playwright/test";
import {
  AUTH_EMULATOR_HOST,
  E2E_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST,
  OWNER,
} from "./tests/e2e/accounts";

/**
 * Browser tests run against the Firebase Auth + Firestore emulators and a
 * Next.js dev server on port 3100 (kept away from the usual 3000 so a running
 * dev session is not disturbed). Both are started here; tests/e2e/global-setup.ts
 * seeds the emulator accounts. One deterministic command: `pnpm test:e2e`.
 *
 * Every value below is fake or emulator-only. The dev server's env is set
 * explicitly so a developer's .env.local never leaks into a test run.
 */
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "firebase-emulators",
      command: `npx -y firebase-tools@latest emulators:start --only auth,firestore --project ${E2E_PROJECT_ID}`,
      url: "http://127.0.0.1:4000",
      reuseExistingServer: !isCI,
      timeout: 240_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      name: "next-dev",
      command: `pnpm dev --port ${PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 240_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        FIRETRACE_USE_EMULATORS: "true",
        NEXT_PUBLIC_FIRETRACE_USE_EMULATORS: "true",
        FIRESTORE_EMULATOR_HOST,
        FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMULATOR_HOST,
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: E2E_PROJECT_ID,
        NEXT_PUBLIC_FIREBASE_API_KEY: "fake-api-key",
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "localhost",
        NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:1",
        NEXT_PUBLIC_APP_URL: BASE_URL,
        DASHBOARD_ALLOWED_EMAILS: OWNER.email,
        FIRETRACE_KEY_PEPPER: "e2e-only-pepper-0123456789abcdef0123456789abcdef",
        FIREBASE_SERVICE_ACCOUNT_BASE64: "",
        GOOGLE_APPLICATION_CREDENTIALS: "",
      },
    },
  ],
});
