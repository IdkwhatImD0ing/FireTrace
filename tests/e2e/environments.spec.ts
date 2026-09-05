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
 * Environments end to end: the key dialog assigns one, ingestion stamps it,
 * the API filters by it and rejects unknown parameters, and the dashboard's
 * selector defaults to production and switches every page.
 */
test.describe.configure({ mode: "serial" });

const PROD_TRACE = "a".repeat(32);
const LEGACY_TRACE = "b".repeat(32);

let page: Page;
let projectId = "";
let productionKey = "";
let legacyKey = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
  projectId = await createProject(page, uniqueName("envs"));
});

test.afterAll(async () => {
  await page.close();
});

test("the key screen offers one key per environment and shows each key's environment", async () => {
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByText("One key per environment", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create production key" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Label")).toHaveValue("production");
  await expect(dialog.getByLabel("Environment", { exact: true })).toHaveValue("production");
  await dialog.getByRole("button", { name: "Create key" }).click();
  const reveal = page.getByRole("status").filter({ hasText: "copy it now" });
  await expect(reveal).toBeVisible();
  productionKey = (await reveal.locator("code").innerText()).trim();
  await expect(page.locator("td .chip", { hasText: "production" })).toHaveCount(1);
  await expect(page.getByText("One key per environment", { exact: true })).toHaveCount(0);

  legacyKey = (await createApiKey(page, projectId, "legacy")).plaintext;
  await expect(page.getByRole("cell", { name: /unassigned/ })).toHaveCount(1);
});

test("the key reports its environment, stamps it on traces, and the API filters strictly", async ({
  request,
}) => {
  const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
  const info = await request.get("/api/v1/key", auth(productionKey));
  expect((await info.json()).environment).toBe("production");
  expect(
    (await request.get("/api/v1/key", auth(legacyKey)).then((r) => r.json())).environment,
  ).toBeNull();

  expect(
    (await postTrace(request, productionKey, sampleTraceRequest({ id: PROD_TRACE }))).status(),
  ).toBe(201);
  expect(
    (await postTrace(request, legacyKey, sampleTraceRequest({ id: LEGACY_TRACE }))).status(),
  ).toBe(201);
  const smuggled = sampleTraceRequest({ id: "c".repeat(32) });
  (smuggled.trace as Record<string, unknown>).environment = "production";
  const rejected = await postTrace(request, productionKey, smuggled);
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).error.message).toContain("environment");

  const production = await request.get("/api/v1/traces?environment=production", auth(legacyKey));
  expect((await production.json()).traces.map((t: { id: string }) => t.id)).toEqual([PROD_TRACE]);
  const unassigned = await request.get("/api/v1/traces?environment=unassigned", auth(legacyKey));
  expect((await unassigned.json()).traces.map((t: { id: string }) => t.id)).toEqual([LEGACY_TRACE]);
  const unknown = await request.get("/api/v1/traces?env=production", auth(legacyKey));
  expect(unknown.status()).toBe(400);
  expect((await unknown.json()).error.message).toContain('"env"');
});

test("the dashboard defaults to production and the selector switches every page and survives reloads", async () => {
  await page.goto(`/projects/${projectId}`);
  const selector = page.locator("select[name=environment]");
  await expect(selector).toHaveValue("production");
  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: "answer-question" }) });
  await expect(rows).toHaveCount(1);
  await expect(page.locator("td .chip", { hasText: "production" })).toHaveCount(1);
  await expect(page.getByText("these counts cover every environment")).toBeVisible();

  await selector.selectOption("unassigned");
  await expect(rows).toHaveCount(1);
  await expect(page.locator("td .chip", { hasText: "production" })).toHaveCount(0);

  await selector.selectOption("all");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("these counts cover every environment")).toHaveCount(0);

  await page.goto(`/projects/${projectId}/dashboard`);
  await expect(selector).toHaveValue("all");
  await expect(page.getByText(/^all environments · UTC/)).toBeVisible();
  await selector.selectOption("production");
  await expect(page.getByText(/^production · UTC/)).toBeVisible();

  await page.reload();
  await expect(selector).toHaveValue("production");
  await page.goto(`/projects/${projectId}/scores`);
  await expect(selector).toHaveValue("production");
  await expect(page.getByText("No production scores match these filters.")).toBeVisible();
});
