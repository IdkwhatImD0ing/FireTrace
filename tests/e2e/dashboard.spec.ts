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
 * The project dashboard reads per-day rollups written at ingest: three traces
 * today (one failed, two names) must show up in the cards and tables without
 * any backfill, and a fresh project gets the empty state.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
const projectName = uniqueName("charted");
let projectId = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
});

test.afterAll(async () => {
  await page.close();
});

test("a fresh project shows the empty state", async () => {
  projectId = await createProject(page, projectName);
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByText("Nothing to chart yet.")).toBeVisible();
});

test("today's traces roll up into cards, charts and tables", async ({ request }) => {
  const apiKey = (await createApiKey(page, projectId, "dashboard-ci")).plaintext;
  const now = Date.now();
  const bodies = [
    sampleTraceRequest({ id: "d1".repeat(16), startedAt: new Date(now - 60_000).toISOString() }),
    sampleTraceRequest({ id: "d2".repeat(16), startedAt: new Date(now - 120_000).toISOString() }),
    sampleTraceRequest({
      id: "d3".repeat(16),
      name: "summarize-thread",
      startedAt: new Date(now - 180_000).toISOString(),
    }),
  ];
  bodies[2].trace.status = "error";
  for (const body of bodies) expect((await postTrace(request, apiKey, body)).status()).toBe(201);
  await request.post(`/api/v1/traces/${"d1".repeat(16)}/scores`, {
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    data: { name: "accuracy", dataType: "numeric", value: 0.8 },
  });

  await page.goto(`/projects/${projectId}/dashboard`);
  const cards = page.locator(".card");
  await expect(page.getByText("1 day with data in range")).toBeVisible();
  await expect(cards.filter({ hasText: "Traces" }).first()).toContainText("3");
  await expect(cards.filter({ hasText: "Error rate" }).first()).toContainText("33.3%");
  await expect(cards.filter({ hasText: "Tokens" }).first()).toContainText("1,524");

  const names = page.getByRole("table").filter({ hasText: "p99" });
  await expect(names.getByRole("cell", { name: "answer-question", exact: true })).toBeVisible();
  await expect(names.getByRole("cell", { name: "summarize-thread", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "example-model", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "accuracy", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "24 hours" }).click();
  await expect(page).toHaveURL(/range=24h/);
  await expect(page.getByText("Traces per hour", { exact: false })).toBeVisible();
  await expect(cards.filter({ hasText: "Traces" }).first()).toContainText("3");

  await page.getByRole("link", { name: "90 days" }).click();
  await expect(page).toHaveURL(/range=90d/);
  await expect(cards.filter({ hasText: "Traces" }).first()).toContainText("3");
});
