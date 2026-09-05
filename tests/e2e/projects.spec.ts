import { expect, test, type Page } from "@playwright/test";
import {
  createApiKey,
  createProject,
  postTrace,
  sampleTraceRequest,
  signInAsOwner,
  uniqueName,
} from "./helpers";

/**
 * One owner journey, in order: two projects, one key each (revealed once),
 * traces that stay inside their own project, tree/inspector interaction,
 * revocation, and the two confirmation-guarded deletions.
 */
test.describe.configure({ mode: "serial" });

const ALPHA_TRACE = "a1".repeat(16);
const BETA_TRACE = "b2".repeat(16);

let page: Page;
const alphaName = uniqueName("alpha");
const betaName = uniqueName("beta");
let alphaId = "";
let betaId = "";
let alphaKey = "";
let betaKey = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
});

test.afterAll(async () => {
  await page.close();
});

test("the owner creates two projects", async () => {
  alphaId = await createProject(page, alphaName);
  betaId = await createProject(page, betaName);
  expect(alphaId).not.toBe(betaId);

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: alphaName, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: betaName, exact: true })).toBeVisible();

  // Names are unique per deployment.
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Name/).fill(alphaName);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("each project gets its own key, revealed exactly once", async () => {
  const alpha = await createApiKey(page, alphaId, "alpha-ci");
  alphaKey = alpha.plaintext;

  // After navigation only the redacted reference remains; the plaintext is not recoverable.
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "copy it now" })).toHaveCount(0);
  expect(await page.content()).not.toContain(alphaKey);
  await expect(page.getByText(`ft_live_${alpha.keyId}_…${alpha.lastFour}`)).toBeVisible();
  await page.goto(`/projects/${alphaId}`);
  expect(await page.content()).not.toContain(alphaKey);

  const beta = await createApiKey(page, betaId, "beta-ci");
  betaKey = beta.plaintext;
  expect(betaKey).not.toBe(alphaKey);
  await page.goto(`/projects/${betaId}/settings`);
  expect(await page.content()).not.toContain(betaKey);
  expect(await page.content()).not.toContain(alphaKey);
});

test("traces sent with each key appear only in their own project", async () => {
  const alphaRes = await postTrace(
    page.request,
    alphaKey,
    sampleTraceRequest({ id: ALPHA_TRACE, name: "alpha-run" }),
  );
  expect(alphaRes.status()).toBe(201);
  expect((await alphaRes.json()).projectId).toBe(alphaId);
  const betaRes = await postTrace(
    page.request,
    betaKey,
    sampleTraceRequest({ id: BETA_TRACE, name: "beta-run" }),
  );
  expect(betaRes.status()).toBe(201);
  expect((await betaRes.json()).projectId).toBe(betaId);

  await page.goto(`/projects/${alphaId}`);
  await expect(page.getByRole("link", { name: "alpha-run" })).toBeVisible();
  await expect(page.getByRole("link", { name: "beta-run" })).toHaveCount(0);

  await page.goto(`/projects/${betaId}`);
  await expect(page.getByRole("link", { name: "beta-run" })).toBeVisible();
  await expect(page.getByRole("link", { name: "alpha-run" })).toHaveCount(0);

  // A trace id that lives in beta is not reachable through alpha's URL space. The
  // trace layout checks existence above every loading boundary, so this is a
  // real 404 status, not a streamed 404 view under a 200.
  const cross = await page.goto(`/projects/${alphaId}/traces/${BETA_TRACE}`);
  expect(cross?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing recorded here." })).toBeVisible();
  await expect(page.getByText("beta-run")).toHaveCount(0);

  await page.goto("/projects");
  await expect(page.getByRole("link", { name: alphaName, exact: true })).toBeVisible();
});

test("selecting spans in the trace tree updates the inspector", async () => {
  await page.goto(`/projects/${alphaId}`);
  await page.getByRole("link", { name: "alpha-run" }).click();
  await page.waitForURL(new RegExp(`/projects/${alphaId}/traces/${ALPHA_TRACE}$`));

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "alpha-run" })).toBeVisible();
  await expect(inspector.getByRole("link", { name: "Download JSON" })).toHaveAttribute(
    "href",
    `/api/projects/${alphaId}/traces/${ALPHA_TRACE}/export`,
  );

  const list = page.getByRole("listbox", { name: "Spans" });
  await expect(list.getByRole("option")).toHaveCount(6); // trace row + 5 spans

  await list.getByRole("option", { name: /generate-text/ }).click();
  await expect(inspector.getByRole("heading", { name: "generate-text" })).toBeVisible();
  await expect(inspector).toContainText("span · llm");
  await inspector.getByRole("tab", { name: /Output/ }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText("Vector search finds items");

  // Keyboard: the row keeps focus after a click, ArrowUp selects the previous row.
  await list.getByRole("option", { name: /lookup-example/ }).click();
  await expect(inspector.getByRole("heading", { name: "lookup-example" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(inspector.getByRole("heading", { name: "search-notes" })).toBeVisible();
  await expect(inspector).toContainText("span · retriever");

  await list.getByRole("option", { name: /lookup-example/ }).click();
  await inspector.getByRole("tab", { name: /Error/ }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText("HTTP 429 Too Many Requests");

  // Back to the trace row: the download link returns.
  await list.getByRole("option", { name: /alpha-run/ }).click();
  await expect(inspector.getByRole("link", { name: "Download JSON" })).toBeVisible();
});

test("revoking a key immediately stops ingestion", async () => {
  await page.goto(`/projects/${betaId}/settings`);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Revoke this key?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke key" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("revoked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);

  const res = await postTrace(
    page.request,
    betaKey,
    sampleTraceRequest({ id: "b3".repeat(16), name: "after-revoke" }),
  );
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("invalid_api_key");

  await page.goto(`/projects/${betaId}`);
  await expect(page.getByRole("link", { name: "beta-run" })).toBeVisible();
  await expect(page.getByRole("link", { name: "after-revoke" })).toHaveCount(0);
});

test("deleting a trace asks for confirmation, then removes it", async () => {
  await page.goto(`/projects/${alphaId}/traces/${ALPHA_TRACE}`);
  await page.getByRole("button", { name: "Delete trace" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Delete this trace?" })).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/traces/${ALPHA_TRACE}$`));
  await page.reload();
  await expect(page.getByRole("heading", { name: "alpha-run", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Delete trace" }).click();
  await dialog.getByRole("button", { name: "Delete trace" }).click();
  await page.waitForURL(new RegExp(`/projects/${alphaId}$`));
  await expect(page.getByRole("link", { name: "alpha-run" })).toHaveCount(0);
  await expect(page.getByText("No traces recorded yet.")).toBeVisible();
  const gone = await page.goto(`/projects/${alphaId}/traces/${ALPHA_TRACE}`);
  expect(gone?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing recorded here." })).toBeVisible();
});

test("deleting a project requires typing its exact name", async () => {
  await page.goto(`/projects/${betaId}/settings`);
  await page.getByRole("button", { name: "Delete project…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Delete this project?" })).toBeVisible();

  const confirm = dialog.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Project name confirmation").fill(`${betaName}-nope`);
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Project name confirmation").fill(betaName);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await page.waitForURL(/\/projects$/);
  await expect(page.getByRole("link", { name: betaName, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: alphaName, exact: true })).toBeVisible();
  const gone = await page.goto(`/projects/${betaId}`);
  expect(gone?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing recorded here." })).toBeVisible();
});
