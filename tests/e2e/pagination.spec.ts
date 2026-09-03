import { expect, test, type Page } from "@playwright/test";
import {
  createApiKey,
  createProject,
  filterControl,
  postTrace,
  sampleTraceRequest,
  signInAsOwner,
  uniqueName,
} from "./helpers";

/**
 * Filters and cursor pagination live in the URL: 60 traces (56 error, 4 ok)
 * give a second page with and without a status filter, and every page is a
 * plain GET that can be bookmarked and reloaded.
 */
test.describe.configure({ mode: "serial" });

const TOTAL = 60;
const PAGE_SIZE = 50;
const ERROR_COUNT = 56; // every 15th trace (0, 15, 30, 45) is "ok"
const BASE_MS = Date.parse("2026-03-01T00:00:00.000Z");

let page: Page;
let projectId = "";
const runLinks = () => page.getByRole("link", { name: /^run-\d+$/ });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
  projectId = await createProject(page, uniqueName("pages"));
  const key = await createApiKey(page, projectId, "seed");
  for (let i = 0; i < TOTAL; i++) {
    const body = sampleTraceRequest({ id: i.toString(16).padStart(32, "0"), name: `run-${i}` });
    body.trace.startedAt = new Date(BASE_MS + i * 60_000).toISOString();
    body.trace.endedAt = new Date(BASE_MS + i * 60_000 + 1200).toISOString();
    body.trace.status = i % 15 === 0 ? "ok" : "error";
    body.trace.model = i % 2 === 0 ? "model-a" : "model-b";
    body.trace.spans = [];
    const res = await postTrace(page.request, key.plaintext, body);
    expect(res.status(), `trace ${i}`).toBe(201);
  }
});

test.afterAll(async () => {
  await page.close();
});

test("the first page shows the 50 newest traces and older/newer links carry cursors", async () => {
  await page.goto(`/projects/${projectId}`);
  await expect(runLinks()).toHaveCount(PAGE_SIZE);
  await expect(runLinks().first()).toHaveText("run-59");
  await expect(runLinks().last()).toHaveText("run-10");
  await expect(page.getByRole("link", { name: /Newer/ })).toHaveCount(0);

  const older = page.getByRole("link", { name: /Older/ });
  await expect(older).toHaveAttribute("href", /\?after=/);
  await older.click();
  await expect(page).toHaveURL(/[?&]after=/);
  await expect(runLinks()).toHaveCount(TOTAL - PAGE_SIZE);
  await expect(runLinks().first()).toHaveText("run-9");
  await expect(runLinks().last()).toHaveText("run-0");
  await expect(page.getByRole("link", { name: /Older/ })).toHaveCount(0);

  // The page URL is a bookmark: reloading it yields the same page.
  const secondPageUrl = page.url();
  await page.goto(secondPageUrl);
  await expect(runLinks()).toHaveCount(TOTAL - PAGE_SIZE);
  await expect(runLinks().first()).toHaveText("run-9");

  const newer = page.getByRole("link", { name: /Newer/ });
  await expect(newer).toHaveAttribute("href", /\?before=/);
  await newer.click();
  await expect(page).toHaveURL(/[?&]before=/);
  await expect(runLinks()).toHaveCount(PAGE_SIZE);
  await expect(runLinks().first()).toHaveText("run-59");
  await expect(runLinks().last()).toHaveText("run-10");
});

test("a status filter lives in the URL and survives pagination and reloads", async () => {
  await page.goto(`/projects/${projectId}`);
  await filterControl(page, "Status").selectOption("error");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]status=error/);
  await expect(filterControl(page, "Status")).toHaveValue("error");
  await expect(runLinks()).toHaveCount(PAGE_SIZE);
  await expect(runLinks().first()).toHaveText("run-59");
  await expect(page.getByRole("link", { name: "run-45", exact: true })).toHaveCount(0);

  const older = page.getByRole("link", { name: /Older/ });
  await expect(older).toHaveAttribute("href", /status=error/);
  await expect(older).toHaveAttribute("href", /after=/);
  await older.click();
  await expect(page).toHaveURL(/status=error/);
  await expect(page).toHaveURL(/after=/);
  await expect(filterControl(page, "Status")).toHaveValue("error");
  await expect(runLinks()).toHaveCount(ERROR_COUNT - PAGE_SIZE);
  await expect(page.getByRole("link", { name: "run-0", exact: true })).toHaveCount(0);

  const bookmark = page.url();
  await page.goto(bookmark);
  await expect(runLinks()).toHaveCount(ERROR_COUNT - PAGE_SIZE);

  const newer = page.getByRole("link", { name: /Newer/ });
  await expect(newer).toHaveAttribute("href", /status=error/);
  await expect(newer).toHaveAttribute("href", /before=/);
  await newer.click();
  await expect(page).toHaveURL(/status=error/);
  await expect(runLinks()).toHaveCount(PAGE_SIZE);

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  await expect(runLinks()).toHaveCount(PAGE_SIZE);
  await expect(page.getByRole("link", { name: "run-45", exact: true })).toBeVisible();
  // The cleared URL is the state: a fresh load renders the form without the filter.
  // (After the client-side "Clear" navigation the uncontrolled <select> still shows the
  // previous value; see TraceFilters defaultValue.)
  await page.reload();
  await expect(filterControl(page, "Status")).toHaveValue("");
  await expect(runLinks()).toHaveCount(PAGE_SIZE);
});

test("status and model filters combine", async () => {
  await page.goto(`/projects/${projectId}`);
  await filterControl(page, "Status").selectOption("error");
  await filterControl(page, "Model").fill("model-a");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/status=error/);
  await expect(page).toHaveURL(/model=model-a/);
  // Even indices are model-a (30); of those 0 and 30 are "ok".
  await expect(runLinks()).toHaveCount(28);
  await expect(page.getByRole("link", { name: /Older/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "run-30", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "run-58", exact: true })).toBeVisible();
  await expect(filterControl(page, "Model")).toHaveValue("model-a");
});
