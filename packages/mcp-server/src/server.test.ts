import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  BackendError,
  type ListTracesQuery,
  type ProjectLike,
  type TraceBackend,
  type TraceDetailLike,
} from "./backend.ts";
import { createFireTraceMcpServer, truncateDeep } from "./server.ts";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

function detail(): TraceDetailLike {
  return {
    trace: {
      id: TRACE_ID,
      name: "answer",
      status: "error",
      startedAt: "2026-09-03T10:00:00.000Z",
      endedAt: "2026-09-03T10:00:02.500Z",
      durationMs: 2500,
      model: "example-model",
      spanCount: 3,
      errorCount: 1,
      input: { prompt: "x".repeat(500) },
    },
    spans: [
      {
        id: "aaaaaaaaaaaaaaaa",
        parentSpanId: null,
        name: "root",
        kind: "agent",
        status: "ok",
        startedAt: "2026-09-03T10:00:00.000Z",
        endedAt: "2026-09-03T10:00:02.500Z",
        durationMs: 2500,
      },
      {
        id: "bbbbbbbbbbbbbbbb",
        parentSpanId: "aaaaaaaaaaaaaaaa",
        name: "generate",
        kind: "llm",
        status: "ok",
        startedAt: "2026-09-03T10:00:00.100Z",
        endedAt: "2026-09-03T10:00:02.000Z",
        durationMs: 1900,
        model: "example-model",
        output: { text: "y".repeat(5000) },
      },
      {
        id: "cccccccccccccccc",
        parentSpanId: "aaaaaaaaaaaaaaaa",
        name: "lookup",
        kind: "tool",
        status: "error",
        startedAt: "2026-09-03T10:00:02.000Z",
        endedAt: "2026-09-03T10:00:02.400Z",
        durationMs: 400,
      },
    ],
  };
}

class FakeBackend implements TraceBackend {
  calls: Array<[string, unknown]> = [];
  deleted: string[] = [];
  readonly projectId = "proj_test";
  constructor(readonly scopes: readonly string[]) {}
  async getProject(): Promise<ProjectLike> {
    this.calls.push(["getProject", null]);
    return {
      id: this.projectId,
      name: "Alpha",
      traceCount: 2,
      spanCount: 6,
      estimatedBytes: 1_500_000,
      lastTraceAt: "2026-09-03T10:00:02.500Z",
      storage: { limitBytes: 500_000_000, level: "ok" },
    };
  }
  async listTraces(query: ListTracesQuery) {
    this.calls.push(["listTraces", query]);
    const d = detail();
    return { traces: [d.trace], nextCursor: query.cursor ? null : "cursor-2" };
  }
  async getTrace(traceId: string) {
    this.calls.push(["getTrace", traceId]);
    return traceId === TRACE_ID ? detail() : null;
  }
  async recordTrace(body: unknown) {
    this.calls.push(["recordTrace", body]);
    const trace = (body as { trace: { id: string } }).trace;
    if (trace.id === "dup") return { ok: true, traceId: "dup", spanCount: 1, duplicate: true };
    if (trace.id === "bad") throw new BackendError(400, "invalid_trace", "spans required");
    return { ok: true, traceId: trace.id, spanCount: 3, duplicate: false };
  }
  async deleteTrace(traceId: string) {
    this.calls.push(["deleteTrace", traceId]);
    if (traceId !== TRACE_ID) throw new BackendError(404, "not_found", "Trace not found.");
    this.deleted.push(traceId);
  }
  async ingestSchema() {
    return { type: "object", properties: { schemaVersion: { const: 1 } } };
  }
}

async function connect(backend: TraceBackend) {
  const server = createFireTraceMcpServer(backend, { version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("createFireTraceMcpServer", () => {
  it("registers tools according to the key's scopes", async () => {
    const all = await connect(new FakeBackend(["traces:write", "traces:read", "traces:delete"]));
    const names = (await all.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "delete_trace",
      "find_spans",
      "get_ingest_schema",
      "get_project",
      "get_trace",
      "list_traces",
      "record_trace",
    ]);
    await all.client.close();

    const readOnly = await connect(new FakeBackend(["traces:read"]));
    expect((await readOnly.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "find_spans",
      "get_project",
      "get_trace",
      "list_traces",
    ]);
    await readOnly.client.close();

    // A key always has at least one scope (normalizeScopes enforces it); with
    // none, the server advertises no tools capability at all.
    const nothing = await connect(new FakeBackend([]));
    await expect(nothing.client.listTools()).rejects.toThrow(/Method not found/);
    await nothing.client.close();
  });

  it("marks read tools read-only and delete_trace destructive", async () => {
    const { client } = await connect(new FakeBackend(["traces:read", "traces:delete"]));
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_traces?.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_trace?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it("list_traces forwards filters, defaults the limit, and reports the cursor", async () => {
    const backend = new FakeBackend(["traces:read"]);
    const { client } = await connect(backend);
    const result = await client.callTool({
      name: "list_traces",
      arguments: { status: "error", model: "example-model" },
    });
    expect(backend.calls[0]).toEqual([
      "listTraces",
      { status: "error", model: "example-model", limit: 20 },
    ]);
    const text = textOf(result);
    expect(text).toContain(TRACE_ID);
    expect(text).toContain('cursor="cursor-2"');
    expect((result.structuredContent as { nextCursor: string }).nextCursor).toBe("cursor-2");
    await client.close();
  });

  it("get_trace prints an outline and truncates long strings", async () => {
    const { client } = await connect(new FakeBackend(["traces:read"]));
    const result = await client.callTool({
      name: "get_trace",
      arguments: { traceId: TRACE_ID.toUpperCase(), maxChars: 100 },
    });
    const text = textOf(result);
    expect(text).toContain("Span outline:");
    expect(text).toContain("- aaaaaaaaaaaaaaaa [agent] root 2.50s");
    expect(text).toContain("  - cccccccccccccccc [tool] lookup 400ms ✗");
    expect(text).toContain("chars truncated]");
    expect(text).not.toContain("y".repeat(200));
    await client.close();
  });

  it("get_trace with includeContent=false omits input/output and 404s cleanly", async () => {
    const { client } = await connect(new FakeBackend(["traces:read"]));
    const lean = await client.callTool({
      name: "get_trace",
      arguments: { traceId: TRACE_ID, includeContent: false },
    });
    expect(textOf(lean)).not.toContain('"output"');
    const missing = await client.callTool({
      name: "get_trace",
      arguments: { traceId: "f".repeat(32) },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("not_found (HTTP 404)");
    await client.close();
  });

  it("find_spans filters by kind, status, and name", async () => {
    const { client } = await connect(new FakeBackend(["traces:read"]));
    const byStatus = await client.callTool({
      name: "find_spans",
      arguments: { traceId: TRACE_ID, status: "error" },
    });
    expect(textOf(byStatus)).toMatch(/^1 of 3 spans match/);
    expect(textOf(byStatus)).toContain("cccccccccccccccc");
    const byName = await client.callTool({
      name: "find_spans",
      arguments: { traceId: TRACE_ID, nameContains: "GEN" },
    });
    expect(textOf(byName)).toContain("bbbbbbbbbbbbbbbb");
    await client.close();
  });

  it("record_trace wraps the trace in the ingest envelope and surfaces backend errors", async () => {
    const backend = new FakeBackend(["traces:write"]);
    const { client } = await connect(backend);
    const stored = await client.callTool({
      name: "record_trace",
      arguments: { trace: { id: "abc", spans: [] } },
    });
    expect(backend.calls[0]).toEqual([
      "recordTrace",
      { schemaVersion: 1, trace: { id: "abc", spans: [] } },
    ]);
    expect(textOf(stored)).toContain("Stored: trace abc with 3 spans.");
    const dup = await client.callTool({
      name: "record_trace",
      arguments: { trace: { id: "dup" } },
    });
    expect(textOf(dup)).toContain("Already stored");
    const bad = await client.callTool({
      name: "record_trace",
      arguments: { trace: { id: "bad" } },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("invalid_trace (HTTP 400): spans required");
    const schema = await client.callTool({ name: "get_ingest_schema", arguments: {} });
    expect(textOf(schema)).toContain('"schemaVersion"');
    await client.close();
  });

  it("delete_trace requires confirm=true and reports not found", async () => {
    const backend = new FakeBackend(["traces:delete"]);
    const { client } = await connect(backend);
    const refused = await client.callTool({
      name: "delete_trace",
      arguments: { traceId: TRACE_ID, confirm: false },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Invalid arguments.*confirm/);
    expect(backend.deleted).toEqual([]);
    const ok = await client.callTool({
      name: "delete_trace",
      arguments: { traceId: TRACE_ID, confirm: true },
    });
    expect(textOf(ok)).toBe(`Deleted trace ${TRACE_ID}.`);
    expect(backend.deleted).toEqual([TRACE_ID]);
    const missing = await client.callTool({
      name: "delete_trace",
      arguments: { traceId: "0".repeat(32), confirm: true },
    });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it("refuses tools outside the key's scopes", async () => {
    const { client } = await connect(new FakeBackend(["traces:read"]));
    const refused = await client.callTool({ name: "record_trace", arguments: { trace: {} } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/not found/i);
    await client.close();
  });
});

describe("truncateDeep", () => {
  it("caps strings at every depth and leaves other values alone", () => {
    const out = truncateDeep(
      { a: "x".repeat(10), b: ["y".repeat(10), 5, null], c: { d: true } },
      4,
    ) as { a: string; b: unknown[]; c: { d: boolean } };
    expect(out.a).toBe("xxxx…[+6 chars truncated]");
    expect(out.b).toEqual(["yyyy…[+6 chars truncated]", 5, null]);
    expect(out.c).toEqual({ d: true });
    expect(truncateDeep("short", 10)).toBe("short");
  });
});
