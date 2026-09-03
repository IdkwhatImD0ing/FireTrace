/**
 * Emulator environment for the Vitest "integration" project. Import this module
 * FIRST in every integration test (before any `@/lib/...` import) so
 * process.env is populated before server modules read it. The tests run inside
 * `firebase emulators:exec` (pnpm test:integration) against the demo project;
 * nothing here can reach a real Firebase project.
 */
export const EMULATOR_PROJECT_ID = "demo-firetrace";
export const FIRESTORE_HOST = "127.0.0.1:8080";
export const AUTH_HOST = "127.0.0.1:9099";
export const OWNER_EMAIL = "owner@example.com";
export const TEST_PEPPER = "integration-test-pepper-0123456789abcdef0123456789abcdef";

process.env.FIRETRACE_USE_EMULATORS = "true";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
process.env.FIRETRACE_KEY_PEPPER = TEST_PEPPER;
process.env.DASHBOARD_ALLOWED_EMAILS = OWNER_EMAIL;
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
// Never let a developer's shell credentials leak into an emulator run.
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
