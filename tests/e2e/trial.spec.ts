import { expect, test, type Page } from "@playwright/test";
import { OWNER } from "./accounts";
import {
  createApiKey,
  createProject,
  createVerifiedAccount,
  postTrace,
  sampleTraceRequest,
  signIn,
  signInAsOwner,
  uniqueName,
} from "./helpers";

/**
 * Trial mode (the dev server runs with FIRETRACE_TRIAL_TRACE_LIMIT=5): an
 * account that is not on the allowlist can sign in, gets one project and five
 * traces, sees the "deploy your own" message afterwards, and never sees the
 * owner's projects, traces, or email. A fresh guest account is created per
 * run so retries start without trial history.
 */
test.describe.configure({ mode: "serial" });

const LIMIT = 5;
const OWNER_TRACE = "d5".repeat(16);
const GUEST = {
  email: `guest-${Date.now().toString(36)}@example.com`,
  password: "firetrace-e2e-password",
  name: "Trial Guest",
};

let ownerProjectId = "";
let guest: Page;
let guestProjectId = "";
let guestKey = "";

test.beforeAll(async ({ browser }) => {
  const ownerPage = await browser.newPage();
  await signInAsOwner(ownerPage);
  ownerProjectId = await createProject(ownerPage, uniqueName("owner-private"));
  const ownerKey = await createApiKey(ownerPage, ownerProjectId, "owner-key");
  const stored = await postTrace(
    ownerPage.request,
    ownerKey.plaintext,
    sampleTraceRequest({ id: OWNER_TRACE, name: "owner-secret-run" }),
  );
  expect(stored.status()).toBe(201);
  await ownerPage.close();

  await createVerifiedAccount(GUEST);
  guest = await browser.newPage();
  await signIn(guest, GUEST);
  await guest.waitForURL(/\/projects$/);
});

test.afterAll(async () => {
  await guest.close();
});

test("a trial user lands on the dashboard with a trial badge and status", async () => {
  await expect(guest.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(guest.getByText("trial", { exact: true })).toBeVisible();
  await expect(guest.getByTestId("trial-status")).toContainText(`0 of ${LIMIT} traces used`);
  await expect(guest.getByText(OWNER.email)).toHaveCount(0);
});

test("the owner's project, trace, and export are invisible to the trial user", async () => {
  await guest.goto("/projects");
  await expect(guest.getByRole("link", { name: /owner-private/ })).toHaveCount(0);
  await expect(guest.getByText(OWNER.email)).toHaveCount(0);

  // The project and trace layouts check access above every loading boundary,
  // so these are real 404 statuses; the rendered view and its content matter too.
  const project = await guest.goto(`/projects/${ownerProjectId}`);
  expect(project?.status()).toBe(404);
  await expect(guest.getByRole("heading", { name: "Nothing recorded here." })).toBeVisible();
  expect(await guest.content()).not.toContain("owner-private");

  const trace = await guest.goto(`/projects/${ownerProjectId}/traces/${OWNER_TRACE}`);
  expect(trace?.status()).toBe(404);
  await expect(guest.getByRole("heading", { name: "Nothing recorded here." })).toBeVisible();
  expect(await guest.content()).not.toContain("owner-secret-run");

  const settings = await guest.request.get(`/projects/${ownerProjectId}/settings`);
  expect(await settings.text()).not.toContain("owner-private");

  const exported = await guest.request.get(
    `/api/projects/${ownerProjectId}/traces/${OWNER_TRACE}/export`,
  );
  expect(exported.status()).toBe(404);
  expect(await exported.text()).not.toContain("owner-secret-run");
});

test("the trial user gets one project and records five traces", async () => {
  guestProjectId = await createProject(guest, uniqueName("guest"));
  const key = await createApiKey(guest, guestProjectId, "guest-key");
  guestKey = key.plaintext;

  for (let i = 1; i <= LIMIT; i++) {
    const res = await postTrace(
      guest.request,
      guestKey,
      sampleTraceRequest({ id: `${i}`.padStart(32, "c"), name: `guest-run-${i}` }),
    );
    expect(res.status(), `trace ${i}`).toBe(201);
  }

  await guest.goto("/projects");
  await expect(guest.getByRole("button", { name: "New project" })).toHaveCount(0);
  await guest.goto(`/projects/${guestProjectId}`);
  await expect(guest.getByTestId("trial-owner-note")).toHaveCount(0);
});

test("the sixth trace is refused and the dashboard tells them to deploy their own", async () => {
  const res = await postTrace(
    guest.request,
    guestKey,
    sampleTraceRequest({ id: "6".padStart(32, "c"), name: "guest-run-6" }),
  );
  expect(res.status()).toBe(403);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("trial_limit_reached");
  expect(body.error.message).toContain("#deploy-your-own");

  await guest.goto(`/projects/${guestProjectId}`);
  const notice = guest.getByTestId("trial-exhausted");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`used all ${LIMIT} trial traces`);
  await expect(notice.getByRole("link", { name: "Deploy your own" })).toHaveAttribute(
    "href",
    /#deploy-your-own$/,
  );
  await expect(notice.getByRole("link", { name: "Prompt for your AI agent" })).toHaveAttribute(
    "href",
    /docs\/deploy-prompt\.md$/,
  );
  // The five stored traces stay readable.
  await expect(guest.getByRole("link", { name: "guest-run-5" })).toBeVisible();

  await guest.goto("/projects");
  await expect(guest.getByTestId("trial-exhausted")).toBeVisible();
});

test("the owner sees the trial project labelled with its owner", async ({ browser }) => {
  const ownerPage = await browser.newPage();
  await signInAsOwner(ownerPage);
  await ownerPage.goto("/projects");
  const card = ownerPage.getByRole("listitem").filter({ hasText: GUEST.email });
  await expect(card).toContainText("trial");
  await ownerPage.goto(`/projects/${guestProjectId}`);
  await expect(ownerPage.getByTestId("trial-owner-note")).toContainText(
    `${LIMIT} of ${LIMIT} traces used`,
  );
  await ownerPage.close();
});
