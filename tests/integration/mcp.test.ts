import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { TEST_PEPPER } from "./env";
import { mcpCall, mcpTool, mcpToolNames } from "./api-helpers";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  OWNER_UID,
  postTrace,
  traceData,
} from "./helpers";

function keyWith(
  projectId: string,
  scopes: Array<"traces:write" | "traces:read" | "traces:delete">,
) {
  return createApiKey(db(), {
    projectId,
    label: scopes.join("+"),
    createdByUid: OWNER_UID,
    pepper: TEST_PEPPER,
    scopes,
  });
}

describe("POST /api/mcp (stateless Streamable HTTP) against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("requires a valid key and answers initialize with server info", async () => {
    const anon = await mcpCall(null, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(anon.status).toBe(401);
    expect(anon.body.error?.message).toContain("invalid_api_key");
    expect(anon.headers.get("www-authenticate")).toContain("Bearer");

    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const init = await mcpCall(key.plaintext, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result?.serverInfo).toMatchObject({ name: "firetrace" });
    expect(String(init.body.result?.instructions)).toContain(project.id);
    expect(init.headers.get("cache-control")).toBe("no-store");
  });

  it("offers only the tools the key's scopes allow", async () => {
    const project = await createTestProject("alpha");
    const readWrite = await createTestKey(project.id);
    const writeOnly = await keyWith(project.id, ["traces:write"]);
    const readOnly = await keyWith(project.id, ["traces:read"]);
    const everything = await keyWith(project.id, ["traces:write", "traces:read", "traces:delete"]);

    expect(await mcpToolNames(readWrite.plaintext)).toEqual([
      "find_spans",
      "get_ingest_schema",
      "get_project",
      "get_trace",
      "list_traces",
      "patch_trace_metadata",
      "record_trace",
    ]);
    expect(await mcpToolNames(writeOnly.plaintext)).toEqual([
      "get_ingest_schema",
      "patch_trace_metadata",
      "record_trace",
    ]);
    expect(await mcpToolNames(readOnly.plaintext)).toEqual([
      "find_spans",
      "get_project",
      "get_trace",
      "list_traces",
    ]);
    expect(await mcpToolNames(everything.plaintext)).toContain("delete_trace");

    const forbidden = await mcpTool(readOnly.plaintext, "record_trace", {
      trace: sampleTraceRequest().trace,
    });
    expect(forbidden.rpc.error ?? forbidden.result?.isError).toBeTruthy();
    expect(await traceData(project.id, sampleTraceRequest().trace.id)).toBeNull();
  });

  it("patches trace metadata through the tool without disturbing the trace", async () => {
    const project = await createTestProject("patchable");
    const key = await keyWith(project.id, ["traces:write", "traces:read"]);
    const body = sampleTraceRequest();
    await mcpTool(key.plaintext, "record_trace", { trace: body.trace });
    const before = await traceData(project.id, body.trace.id);

    const patched = await mcpTool(key.plaintext, "patch_trace_metadata", {
      traceId: body.trace.id,
      metadata: { feedback: 1, feedbackLabel: "thumbs-up" },
    });
    expect(patched.result?.isError).toBeFalsy();
    expect(patched.text).toContain("Merged into the metadata");
    expect(patched.result?.structuredContent).toMatchObject({
      traceId: body.trace.id,
      changed: true,
    });

    const after = await traceData(project.id, body.trace.id);
    expect(after!.metadata).toMatchObject({ feedback: 1, feedbackLabel: "thumbs-up" });
    expect(after!.bodyHash).toBe(before!.bodyHash);
    expect(after!.name).toBe(before!.name);

    const repeat = await mcpTool(key.plaintext, "patch_trace_metadata", {
      traceId: body.trace.id,
      metadata: { feedback: 1, feedbackLabel: "thumbs-up" },
    });
    expect(repeat.text).toContain("Already matched");

    const missing = await mcpTool(key.plaintext, "patch_trace_metadata", {
      traceId: "f".repeat(32),
      metadata: { feedback: 1 },
    });
    expect(missing.result?.isError).toBe(true);
    expect(missing.text).toContain("not_found");
  });

  it("records, lists, inspects, searches, and deletes traces through tools", async () => {
    const project = await createTestProject("alpha");
    const key = await keyWith(project.id, ["traces:write", "traces:read", "traces:delete"]);
    const body = sampleTraceRequest();

    const recorded = await mcpTool(key.plaintext, "record_trace", { trace: body.trace });
    expect(recorded.result?.isError).toBeFalsy();
    expect(recorded.text).toContain(`Stored: trace ${body.trace.id}`);
    expect(recorded.result?.structuredContent).toMatchObject({
      traceId: body.trace.id,
      duplicate: false,
    });
    expect(await traceData(project.id, body.trace.id)).not.toBeNull();

    const again = await mcpTool(key.plaintext, "record_trace", { trace: body.trace });
    expect(again.text).toContain("Already stored");

    const invalid = await mcpTool(key.plaintext, "record_trace", {
      trace: { ...body.trace, id: "short" },
    });
    expect(invalid.result?.isError).toBe(true);
    expect(invalid.text).toContain("invalid_trace");

    const project_ = await mcpTool(key.plaintext, "get_project");
    expect(project_.text).toContain("1 traces, 5 spans");

    const list = await mcpTool(key.plaintext, "list_traces", { status: "ok", limit: 10 });
    expect(list.text).toContain(body.trace.id);
    expect(list.text).toContain("End of results.");
    const structured = list.result?.structuredContent as { traces: Array<{ id: string }> };
    expect(structured.traces.map((t) => t.id)).toEqual([body.trace.id]);

    const none = await mcpTool(key.plaintext, "list_traces", { status: "error" });
    expect(none.text).toContain("No traces match.");

    const detail = await mcpTool(key.plaintext, "get_trace", {
      traceId: body.trace.id,
      maxChars: 60,
    });
    expect(detail.text).toContain("Span outline:");
    expect(detail.text).toContain("[tool]");
    expect(detail.text).toContain("✗");
    expect(detail.text).toContain('"spans"');

    const spans = await mcpTool(key.plaintext, "find_spans", {
      traceId: body.trace.id,
      status: "error",
    });
    expect(spans.text).toMatch(/^1 of 5 spans match/);
    expect(spans.text).toContain("b7ad6b7169203331");

    const missing = await mcpTool(key.plaintext, "get_trace", { traceId: "0".repeat(32) });
    expect(missing.result?.isError).toBe(true);
    expect(missing.text).toContain("not_found");

    const unconfirmed = await mcpTool(key.plaintext, "delete_trace", {
      traceId: body.trace.id,
      confirm: false,
    });
    expect(unconfirmed.rpc.error ?? unconfirmed.result?.isError).toBeTruthy();
    expect(await traceData(project.id, body.trace.id)).not.toBeNull();

    const deleted = await mcpTool(key.plaintext, "delete_trace", {
      traceId: body.trace.id,
      confirm: true,
    });
    expect(deleted.result?.isError).toBeFalsy();
    expect(await traceData(project.id, body.trace.id)).toBeNull();
  });

  it("serves the ingest schema and never crosses projects", async () => {
    const alpha = await createTestProject("alpha");
    const beta = await createTestProject("beta");
    const alphaKey = await createTestKey(alpha.id);
    const betaKey = await createTestKey(beta.id);
    expect((await postTrace(sampleTraceRequest(), alphaKey.plaintext)).status).toBe(201);

    const schema = await mcpTool(betaKey.plaintext, "get_ingest_schema");
    expect(schema.text).toContain('"schemaVersion"');
    expect(schema.text).toContain('"spans"');

    const list = await mcpTool(betaKey.plaintext, "list_traces");
    expect(list.text).toContain("No traces match.");
    const one = await mcpTool(betaKey.plaintext, "get_trace", {
      traceId: sampleTraceRequest().trace.id,
    });
    expect(one.result?.isError).toBe(true);
  });

  it("answers GET and DELETE with 405 because the endpoint is stateless", async () => {
    const { GET, DELETE } = await import("@/app/api/mcp/route");
    const get = await GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const del = await DELETE();
    expect(del.status).toBe(405);
  });
});
