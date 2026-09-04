import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createApiKey,
  createProject,
  postTrace,
  sampleTraceRequest,
  signInAsOwner,
  uniqueName,
} from "./helpers";

/**
 * The journey the metadata patch exists for: an application records a trace,
 * a reader rates the answer afterwards, and the rating shows up on the trace
 * page without the trace itself changing.
 */
test.describe.configure({ mode: "serial" });

const TRACE_ID = "c3".repeat(16);

let page: Page;
const projectName = uniqueName("rated");
let projectId = "";
let apiKey = "";

function patchMetadata(request: APIRequestContext, metadata: Record<string, unknown>) {
  return request.patch(`/api/v1/traces/${TRACE_ID}`, {
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    data: { metadata },
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
});

test.afterAll(async () => {
  await page.close();
});

test("a rating recorded after the trace lands in its metadata", async ({ request }) => {
  projectId = await createProject(page, projectName);
  apiKey = (await createApiKey(page, projectId, "metadata-ci")).plaintext;
  expect((await postTrace(request, apiKey, sampleTraceRequest({ id: TRACE_ID }))).status()).toBe(
    201,
  );

  const rated = await patchMetadata(request, {
    feedback: 0,
    feedbackLabel: "thumbs-down",
    feedbackComment: "cited the wrong page",
  });
  expect(rated.status()).toBe(200);
  expect((await rated.json()).changed).toBe(true);

  // A correction replaces the value rather than accumulating a second one.
  const corrected = await patchMetadata(request, { feedback: 1, feedbackLabel: "thumbs-up" });
  expect(((await corrected.json()).metadata as { feedback: number }).feedback).toBe(1);
});

test("the trace page shows the patched metadata in the inspector", async () => {
  await page.goto(`/projects/${projectId}/traces/${TRACE_ID}`);
  await page.getByRole("tab", { name: /^Metadata/ }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText("feedback");
  await expect(panel).toContainText("thumbs-up");
  await expect(panel).toContainText("cited the wrong page");
});

test("the rest of the trace is untouched by the patch", async ({ request }) => {
  const res = await request.get(`/api/v1/traces/${TRACE_ID}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    trace: { name: string; durationMs: number; metadataUpdatedAt: string | null };
    spans: unknown[];
  };
  const original = sampleTraceRequest({ id: TRACE_ID }).trace;
  expect(body.trace.name).toBe(original.name);
  expect(body.spans).toHaveLength(original.spans?.length ?? 0);
  expect(body.trace.metadataUpdatedAt).not.toBeNull();

  // The original body is still recognised as the same trace, not a conflict.
  const resend = await postTrace(request, apiKey, sampleTraceRequest({ id: TRACE_ID }));
  expect(resend.status()).toBe(200);
  expect((await resend.json()).duplicate).toBe(true);
});
