/**
 * Fixed emulator accounts for the browser tests. Seeded by global-setup.ts
 * against the Auth emulator; nothing here exists in a real Firebase project.
 */
export const E2E_PROJECT_ID = "demo-firetrace";
export const AUTH_EMULATOR_HOST = "127.0.0.1:9099";
export const FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

export const OWNER = {
  email: "owner@example.com",
  password: "firetrace-e2e-password",
  name: "E2E Owner",
};

export const OUTSIDER = {
  email: "outsider@example.com",
  password: "firetrace-e2e-password",
  name: "Not Allowlisted",
};
