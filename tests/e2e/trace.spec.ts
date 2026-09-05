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
 * The trace page's reading tools: span search and collapse in the tree,
 * chat-shaped input rendered as messages, newer/older navigation that follows
 * the list's filters, and the per-day histogram above the list.
 */
test.describe.configure({ mode: "serial" });

const COUNT = 3;
const ids = Array.from({ length: COUNT }, (_, i) => i.toString(16).padStart(32, "a"));
// Today, 01:00 UTC onwards, so every trace lands in the histogram's last bucket.
const todayMs = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3_600_000;

let page: Page;
let projectId = "";
const projectName = uniqueName("trace-page");
const options = () => page.getByRole("listbox", { name: "Spans" }).getByRole("option");

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
  projectId = await createProject(page, projectName);
  const key = await createApiKey(page, projectId, "seed");
  for (let i = 0; i < COUNT; i++) {
    const body = sampleTraceRequest({
      id: ids[i],
      name: `t-${i}`,
      startedAt: new Date(todayMs + i * 60_000).toISOString(),
    });
    body.trace.status = i === 1 ? "error" : "ok";
    const res = await postTrace(page.request, key.plaintext, body);
    expect(res.status(), `trace ${i}`).toBe(201);
  }
});

test.afterAll(async () => {
  await page.close();
});

test("search narrows the span tree to matches and their ancestors; collapse hides children", async () => {
  await page.goto(`/projects/${projectId}/traces/${ids[1]}`);
  await expect(options()).toHaveCount(6); // trace row + agent root + 4 children

  const search = page.getByLabel("Find span by name");
  await search.fill("plan");
  await expect(options()).toHaveCount(3);
  await expect(options().nth(1)).toContainText("answer-question");
  await expect(options().nth(2)).toContainText("plan");
  await search.fill("");
  await expect(options()).toHaveCount(6);

  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(options()).toHaveCount(2);
  await expect(options().nth(1)).toContainText("+4");
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(options()).toHaveCount(6);

  // Arrow keys toggle the selected node.
  await options().nth(1).click();
  await page.keyboard.press("ArrowLeft");
  await expect(options()).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(options()).toHaveCount(6);

  // Inline metrics on LLM spans.
  await expect(options().filter({ hasText: "plan" })).toContainText("156 tok");
});

test("chat-shaped span input renders as messages with a JSON toggle", async () => {
  await options().filter({ hasText: /^plan/ }).click();
  await page.getByRole("tab", { name: "Input" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText("1 message");
  await expect(panel.getByText("user", { exact: true })).toBeVisible();
  await expect(panel).toContainText("Plan how to answer: explain vector search.");
  await panel.getByRole("group", { name: "View as" }).getByRole("button", { name: "JSON" }).click();
  await expect(panel).toContainText('"messages"');

  // A plain object is not a chat: no toggle, just JSON.
  await options().first().click();
  await page.getByRole("tab", { name: "Input" }).click();
  await expect(page.getByRole("tabpanel")).toContainText('"prompt"');
  await expect(page.getByRole("tabpanel").getByRole("group", { name: "View as" })).toHaveCount(0);
});

test("newer/older links and the [ ] keys walk the list in its filtered order", async () => {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("link", { name: "t-1", exact: true }).click();
  await page.waitForURL(new RegExp(`/traces/${ids[1]}$`));
  const nav = page.getByRole("navigation", { name: "Neighbouring traces" });
  await expect(nav.getByRole("link", { name: /Newer/ })).toHaveAttribute(
    "href",
    new RegExp(`/traces/${ids[2]}$`),
  );
  await expect(nav.getByRole("link", { name: /Older/ })).toHaveAttribute(
    "href",
    new RegExp(`/traces/${ids[0]}$`),
  );

  await page.keyboard.press("]");
  await page.waitForURL(new RegExp(`/traces/${ids[0]}$`));
  await expect(page.getByRole("heading", { name: "t-0", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Older/ })).toHaveCount(0);
  await page.keyboard.press("[");
  await page.waitForURL(new RegExp(`/traces/${ids[1]}$`));

  // With a filter, neighbours come from the filtered list and links keep the query.
  await page.goto(`/projects/${projectId}?status=ok`);
  await page.getByRole("link", { name: "t-2", exact: true }).click();
  await page.waitForURL(/\?status=ok$/);
  await expect(nav.getByRole("link", { name: /Older/ })).toHaveAttribute(
    "href",
    new RegExp(`/traces/${ids[0]}\\?status=ok$`),
  );
  await expect(page.locator("a.mono-label").filter({ hasText: projectName })).toHaveAttribute(
    "href",
    new RegExp(`/projects/${projectId}\\?status=ok$`),
  );
});

test("the histogram above the list links each day to a time-range filter", async () => {
  await page.goto(`/projects/${projectId}`);
  const bar = page.locator('figure a[href*="?from="]').filter({ hasText: "" }).last();
  await expect(bar).toHaveAttribute("title", /3 traces \(1 with errors\)/);
  await bar.click();
  await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}T00:00&to=\d{4}-\d{2}-\d{2}T23:59$/);
  await expect(page.getByRole("link", { name: /^t-\d$/ })).toHaveCount(COUNT);
});
