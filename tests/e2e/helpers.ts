import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { sampleTraceRequest } from "../../src/lib/firetrace/sample";
import type { IngestRequest } from "../../src/lib/firetrace/schema";
import { AUTH_EMULATOR_HOST, E2E_PROJECT_ID, OWNER } from "./accounts";

export { sampleTraceRequest };

export const KEY_RE = /^ft_live_[0-9a-f]{16}_[0-9a-f]{64}$/;
export const PROJECT_URL_RE = /\/projects\/([0-9a-f]{24})$/;
export const SESSION_COOKIE = "firetrace_session";

/** Alerts with content; Next.js also mounts an empty role="alert" route announcer. */
export function alerts(page: Page): Locator {
  return page.getByRole("alert").filter({ hasText: /\S/ });
}

/** Wrapping labels include the control's own value in its name ("Status any"), so match the prefix. */
export function filterControl(
  page: Page,
  label: "Status" | "Model" | "Session ID" | "User ID",
): Locator {
  return page.getByLabel(new RegExp(`^${label}`));
}

/** Unique per run so re-running against a reused emulator never collides on project names. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function signIn(
  page: Page,
  account: { email: string; password: string },
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function signInAsOwner(page: Page): Promise<void> {
  await signIn(page, OWNER);
  await page.waitForURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
}

/** Create a project through the dialog and return its generated id from the URL. */
export async function createProject(page: Page, name: string): Promise<string> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Create a project" })).toBeVisible();
  await dialog.getByLabel(/^Name/).fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(PROJECT_URL_RE);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  const match = PROJECT_URL_RE.exec(page.url());
  if (!match) throw new Error(`Unexpected project URL: ${page.url()}`);
  return match[1];
}

/** Create an API key in project settings and capture the one-time plaintext reveal. */
export async function createApiKey(
  page: Page,
  projectId: string,
  label: string,
): Promise<{ plaintext: string; keyId: string; lastFour: string }> {
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Create an API key" })).toBeVisible();
  await dialog.getByLabel("Label").fill(label);
  await dialog.getByRole("button", { name: "Create key" }).click();
  const reveal = page.getByRole("status").filter({ hasText: "copy it now" });
  await expect(reveal).toBeVisible();
  const plaintext = (await reveal.locator("code").innerText()).trim();
  expect(plaintext).toMatch(KEY_RE);
  return { plaintext, keyId: plaintext.split("_")[2], lastFour: plaintext.slice(-4) };
}

export function postTrace(
  request: APIRequestContext,
  apiKey: string,
  body: IngestRequest,
): Promise<APIResponse> {
  return request.post("/api/v1/traces", {
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    data: body,
  });
}

/**
 * Create a fresh verified email/password account in the Auth emulator. Used
 * by the trial spec so every run (and every CI retry) starts with an account
 * that has no trial history.
 */
export async function createVerifiedAccount(account: {
  email: string;
  password: string;
  name: string;
}): Promise<void> {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR_HOST;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const { deleteApp, getApps, initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const app = getApps()[0] ?? initializeApp({ projectId: E2E_PROJECT_ID });
  await getAuth(app).createUser({
    email: account.email,
    password: account.password,
    emailVerified: true,
    displayName: account.name,
  });
  await deleteApp(app);
}
