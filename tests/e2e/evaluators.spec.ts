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
 * Evaluator definitions without a judge endpoint: the e2e server sets no
 * FIRETRACE_EVAL_* variables, so the page must explain that, still let the
 * owner define evaluators from a template, and keep Test/Run disabled.
 */
test.describe.configure({ mode: "serial" });

const TRACE_ID = "e5".repeat(16);

let page: Page;
const projectName = uniqueName("judged");
let projectId = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
});

test.afterAll(async () => {
  await page.close();
});

test("the evaluators page explains the missing endpoint and offers templates", async ({
  request,
}) => {
  projectId = await createProject(page, projectName);
  const apiKey = (await createApiKey(page, projectId, "evals-ci")).plaintext;
  expect((await postTrace(request, apiKey, sampleTraceRequest({ id: TRACE_ID }))).status()).toBe(
    201,
  );

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("link", { name: "Evaluators" }).click();
  await expect(page.getByRole("heading", { name: "Evaluators", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("FIRETRACE_EVAL_BASE_URL");
  await expect(page.getByText("No evaluators yet.")).toBeVisible();
  await expect(page.getByText("No runs yet.")).toBeVisible();
});

test("a definition can be created from a template, edited and deleted", async () => {
  await page.getByRole("button", { name: "New evaluator" }).click();
  await page.getByLabel(/^Start from/).selectOption("correctness");
  await expect(page.getByLabel(/^Name/)).toHaveValue("correctness");
  await expect(page.getByLabel(/^Prompt/)).toHaveValue(/\{\{input\}\}/);
  await expect(page.getByRole("button", { name: "Test" })).toBeDisabled();

  await page.getByLabel(/^Name/).fill("answer_quality");
  await page.getByRole("button", { name: "Create evaluator" }).click();
  await expect(page.getByText("answer_quality", { exact: true })).toBeVisible();
  await expect(page.getByText("number 0–1")).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel(/^Score type/).selectOption("categorical");
  await page.getByLabel(/^Choices/).fill("good, bad");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("good · bad")).toBeVisible();

  await page.getByRole("button", { name: "New evaluator" }).click();
  await page.getByLabel(/^Name/).fill("has space");
  await page.getByLabel(/^Prompt/).fill("{{output}}");
  await page.getByRole("button", { name: "Create evaluator" }).click();
  // The browser's own pattern check keeps the form open; no evaluator is added.
  await expect(page.getByRole("button", { name: "Create evaluator" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete evaluator answer_quality" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText("No evaluators yet.")).toBeVisible();
});

test("the trace page offers a run control that stays disabled without an endpoint", async () => {
  await page.goto(`/projects/${projectId}/evaluators`);
  await page.getByRole("button", { name: "New evaluator" }).click();
  await page.getByLabel(/^Start from/).selectOption("topic");
  await page.getByRole("button", { name: "Create evaluator" }).click();
  await expect(page.getByText("topic", { exact: true })).toBeVisible();

  await page.goto(`/projects/${projectId}/traces/${TRACE_ID}`);
  await page.getByRole("tab", { name: /^Scores/ }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByLabel(/^Run evaluator/)).toHaveValue(/.+/);
  await expect(panel.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await expect(panel).toContainText("FIRETRACE_EVAL_MODEL");

  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole("button", { name: /^Run on these 1 trace/ })).toBeDisabled();
});
