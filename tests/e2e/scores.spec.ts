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
 * Scores end to end: an application rates a trace through the API, the owner
 * annotates it from the inspector, and both show up on the trace list, the
 * trace page and the project's scores page.
 */
test.describe.configure({ mode: "serial" });

const TRACE_ID = "d4".repeat(16);

let page: Page;
const projectName = uniqueName("scored");
let projectId = "";
let apiKey = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
});

test.afterAll(async () => {
  await page.close();
});

test("a score sent through the API shows on the trace list and the trace page", async ({
  request,
}) => {
  projectId = await createProject(page, projectName);
  apiKey = (await createApiKey(page, projectId, "scores-ci")).plaintext;
  expect((await postTrace(request, apiKey, sampleTraceRequest({ id: TRACE_ID }))).status()).toBe(
    201,
  );

  const added = await request.post(`/api/v1/traces/${TRACE_ID}/scores`, {
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    data: { name: "accuracy", dataType: "numeric", value: 0.8, comment: "cited the right page" },
  });
  expect(added.status()).toBe(201);

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("cell", { name: /accuracy=0\.8/ })).toBeVisible();

  await page.goto(`/projects/${projectId}/traces/${TRACE_ID}`);
  await page.getByRole("tab", { name: /^Scores/ }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText("accuracy");
  await expect(panel).toContainText("= 0.8");
  await expect(panel).toContainText("cited the right page");
  await expect(panel).toContainText("api");
});

test("the owner annotates the trace from the inspector and the scores page sums it up", async () => {
  const panel = page.getByRole("tabpanel");
  await panel.getByLabel(/^Name/).fill("helpful");
  await panel.getByLabel(/^Type/).selectOption("boolean");
  await panel.getByLabel(/^Value/).selectOption("true");
  await panel.getByLabel(/^Comment/).fill("answered the question");
  await panel.getByRole("button", { name: "Add score" }).click();
  await expect(panel).toContainText("helpful");
  await expect(panel).toContainText("= true");
  await expect(panel).toContainText("annotation");
  await expect(panel).toContainText("answered the question");

  await page.goto(`/projects/${projectId}/scores`);
  await expect(page.getByRole("heading", { name: "Scores", level: 1 })).toBeVisible();
  await expect(page.getByText("average of 1")).toBeVisible();
  await expect(page.getByRole("cell", { name: "helpful", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "accuracy", exact: true })).toBeVisible();

  await page.getByLabel(/^Name/).fill("accuracy");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/name=accuracy/);
  await expect(page.getByRole("cell", { name: "accuracy", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "helpful", exact: true })).toHaveCount(0);
});

test("deleting a score from the inspector removes it everywhere", async () => {
  await page.goto(`/projects/${projectId}/traces/${TRACE_ID}`);
  await page.getByRole("tab", { name: /^Scores/ }).click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Delete score helpful" }).click();
  await panel.getByRole("button", { name: "Confirm" }).click();
  await expect(panel).not.toContainText("= true");
  await expect(panel).toContainText("= 0.8");

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("cell", { name: /accuracy=0\.8/ })).toBeVisible();
  await expect(page.getByText("helpful=true")).toHaveCount(0);
});
