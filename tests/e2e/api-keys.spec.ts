import { expect, test, type Page } from "@playwright/test";
import {
  createApiKey,
  createProject,
  KEY_RE,
  postTrace,
  sampleTraceRequest,
  signInAsOwner,
  uniqueName,
} from "./helpers";

/**
 * Scoped keys end to end: the settings dialog issues a read-only key with an
 * expiry, the table shows scopes and expiry, and the REST + MCP surfaces
 * enforce the scopes with the same bearer key.
 */
test.describe.configure({ mode: "serial" });

const TRACE_ID = "c4".repeat(16);

let page: Page;
let projectId = "";
let readKey = "";
let writeKey = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signInAsOwner(page);
  projectId = await createProject(page, uniqueName("scoped"));
});

test.afterAll(async () => {
  await page.close();
});

test("the owner issues a read-only key that expires in 30 days", async () => {
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label").fill("reader");
  const write = dialog.getByRole("checkbox", { name: /traces:write/ });
  const read = dialog.getByRole("checkbox", { name: /traces:read/ });
  await expect(write).toBeChecked();
  await expect(read).toBeChecked();
  await write.uncheck();
  await dialog.getByLabel("Expires").selectOption("30d");
  await dialog.getByRole("button", { name: "Create key" }).click();

  const reveal = page.getByRole("status").filter({ hasText: "copy it now" });
  await expect(reveal).toBeVisible();
  readKey = (await reveal.locator("code").innerText()).trim();
  expect(readKey).toMatch(KEY_RE);

  const row = page.getByRole("row").filter({ hasText: "reader" });
  await expect(row).toContainText("read");
  await expect(row).not.toContainText("write");
  const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  await expect(row).toContainText(expected);
  await expect(row).toContainText("active");
});

test("a default key keeps write + read and the create button refuses an empty scope set", async () => {
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByRole("button", { name: "Create key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label").fill("nothing");
  await dialog.getByRole("checkbox", { name: /traces:write/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /traces:read/ }).uncheck();
  await expect(dialog.getByRole("button", { name: "Create key" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const created = await createApiKey(page, projectId, "writer");
  writeKey = created.plaintext;
  const row = page.getByRole("row").filter({ hasText: "writer" });
  await expect(row).toContainText("write");
  await expect(row).toContainText("read");
  await expect(row).toContainText("never");
});

test("the REST API enforces scopes with the same bearer keys", async () => {
  const denied = await postTrace(
    page.request,
    readKey,
    sampleTraceRequest({ id: TRACE_ID, name: "scoped-run" }),
  );
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe("insufficient_scope");

  const stored = await postTrace(
    page.request,
    writeKey,
    sampleTraceRequest({ id: TRACE_ID, name: "scoped-run" }),
  );
  expect(stored.status()).toBe(201);

  const list = await page.request.get("/api/v1/traces?status=ok", {
    headers: { authorization: `Bearer ${readKey}` },
  });
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { traces: Array<{ id: string; name: string }> };
  expect(body.traces.map((t) => t.id)).toEqual([TRACE_ID]);

  const detail = await page.request.get(`/api/v1/traces/${TRACE_ID}`, {
    headers: { authorization: `Bearer ${readKey}` },
  });
  expect(detail.status()).toBe(200);
  expect((await detail.json()).spans).toHaveLength(5);

  const del = await page.request.delete(`/api/v1/traces/${TRACE_ID}`, {
    headers: { authorization: `Bearer ${readKey}` },
  });
  expect(del.status()).toBe(403);

  const key = await page.request.get("/api/v1/key", {
    headers: { authorization: `Bearer ${readKey}` },
  });
  expect(key.status()).toBe(200);
  expect((await key.json()).scopes).toEqual(["traces:read"]);

  const anon = await page.request.get("/api/v1/project");
  expect(anon.status()).toBe(401);
  expect(anon.headers()["www-authenticate"]).toContain("Bearer");

  const openapi = await page.request.get("/api/v1/openapi.json");
  expect(openapi.status()).toBe(200);
  expect(Object.keys((await openapi.json()).paths)).toContain("/api/v1/traces/{traceId}");
});

test("the MCP endpoint offers scope-appropriate tools and reads the trace", async () => {
  const call = (apiKey: string, method: string, params: Record<string, unknown>, id = 1) =>
    page.request.post("/api/mcp", {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      data: { jsonrpc: "2.0", id, method, params },
    });

  const tools = await call(readKey, "tools/list", {});
  expect(tools.status()).toBe(200);
  const names = ((await tools.json()).result.tools as Array<{ name: string }>)
    .map((t) => t.name)
    .sort();
  expect(names).toEqual(["find_spans", "get_project", "get_trace", "list_traces"]);

  const listed = await call(readKey, "tools/call", {
    name: "list_traces",
    arguments: { limit: 5 },
  });
  const text = ((await listed.json()).result.content as Array<{ text: string }>)[0].text;
  expect(text).toContain(TRACE_ID);
  expect(text).toContain("scoped-run");

  const anon = await page.request.post("/api/mcp", {
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
  });
  expect(anon.status()).toBe(401);
});

test("revoking the read key ends its access immediately", async () => {
  await page.goto(`/projects/${projectId}/settings`);
  const row = page.getByRole("row").filter({ hasText: "reader" });
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(row).toContainText("revoked");
  const after = await page.request.get("/api/v1/key", {
    headers: { authorization: `Bearer ${readKey}` },
  });
  expect(after.status()).toBe(401);
});
