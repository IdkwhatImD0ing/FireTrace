import "./env";
import { beforeAll, describe, expect, it } from "vitest";
import { traceDocument } from "@/lib/firetrace/ingest";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { listTraces, recentFacets } from "@/lib/firetrace/queries";
import type { IngestRequest } from "@/lib/firetrace/schema";
import type { TracePage } from "@/lib/firetrace/types";
import { callApi, mcpTool } from "./api-helpers";
import { clearFirestore, createTestKey, createTestProject, db } from "./helpers";

const TOTAL = 30;
const BASE_MS = Date.parse("2026-02-01T00:00:00.000Z");

/** Durations climb with i, costs only exist for odd i, names alternate, tags by remainder. */
function requestFor(i: number): IngestRequest {
  const startedAt = new Date(BASE_MS + i * 60_000).toISOString();
  return {
    schemaVersion: 1,
    trace: {
      id: i.toString(16).padStart(32, "0"),
      name: i % 2 ? "summarize-thread" : "answer-question",
      status: i % 5 === 0 ? "error" : "ok",
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + (i + 1) * 100).toISOString(),
      model: i % 3 === 0 ? "model-a" : "model-b",
      sessionId: `session-${i % 4}`,
      tags: i % 3 === 0 ? ["prod", "chat"] : ["dev"],
      metadata: {},
      usage: {},
      ...(i % 2 ? { costUsd: i / 1000 } : {}),
      spans: [],
    },
  };
}

const ids = (list: TracePage) => list.traces.map((t) => t.id);
const idOf = (i: number) => i.toString(16).padStart(32, "0");
const range = (from: number, to: number, step = -1) => {
  const out: number[] = [];
  for (let i = from; step < 0 ? i >= to : i <= to; i += step) out.push(i);
  return out;
};

describe("name/tag filters and sort presets against the emulator", () => {
  let projectId = "";
  let apiKey = "";

  beforeAll(async () => {
    await clearFirestore();
    const project = await createTestProject("sorted");
    projectId = project.id;
    apiKey = (await createTestKey(projectId, "reader")).plaintext;
    const traces = db().collection("projects").doc(projectId).collection("traces");
    const batch = db().batch();
    for (let i = 0; i < TOTAL; i++) {
      const normalized = normalizeIngestBody(requestFor(i));
      if (!normalized.ok) throw new Error(normalized.error.message);
      const { trace, bodyHash, estimatedBytes } = normalized.value;
      batch.set(traces.doc(trace.id), traceDocument(trace, bodyHash, estimatedBytes));
    }
    await batch.commit();
  });

  it("filters by exact name and by one tag, newest first", async () => {
    const named = await listTraces(db(), projectId, { name: "answer-question" }, {});
    expect(ids(named)).toEqual(range(28, 0, -2).map(idOf));
    const tagged = await listTraces(db(), projectId, { tag: "prod" }, {});
    expect(ids(tagged)).toEqual(range(27, 0, -3).map(idOf));
    const both = await listTraces(db(), projectId, { tag: "prod", status: "error" }, {});
    expect(ids(both)).toEqual([15, 0].map(idOf));
  });

  it("orders by duration or cost with working cursors in both directions", async () => {
    const slow = await listTraces(db(), projectId, {}, { sort: "slowest", limit: 10 });
    expect(ids(slow)).toEqual(range(29, 20).map(idOf));
    expect(slow.nextCursor).toBeTruthy();
    const next = await listTraces(
      db(),
      projectId,
      {},
      { sort: "slowest", limit: 10, after: slow.nextCursor! },
    );
    expect(ids(next)).toEqual(range(19, 10).map(idOf));
    const back = await listTraces(
      db(),
      projectId,
      {},
      { sort: "slowest", limit: 10, before: next.prevCursor! },
    );
    expect(ids(back)).toEqual(range(29, 20).map(idOf));

    // Costliest omits traces without a cost (the even ones).
    const costly = await listTraces(db(), projectId, {}, { sort: "costliest", limit: 5 });
    expect(ids(costly)).toEqual([29, 27, 25, 23, 21].map(idOf));
    const costlyErrors = await listTraces(
      db(),
      projectId,
      { status: "error", tag: "prod" },
      { sort: "costliest" },
    );
    expect(ids(costlyErrors)).toEqual([15].map(idOf));
  });

  it("refuses sorts that no index supports and cursors from another sort", async () => {
    await expect(
      listTraces(db(), projectId, { sessionId: "session-1" }, { sort: "slowest" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(
      listTraces(db(), projectId, { from: "2026-02-01T00:00:00Z" }, { sort: "costliest" }),
    ).rejects.toMatchObject({ status: 400 });
    const newest = await listTraces(db(), projectId, {}, { limit: 5 });
    await expect(
      listTraces(db(), projectId, {}, { sort: "slowest", after: newest.nextCursor! }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("lists distinct names, models and tags for the filter suggestions", async () => {
    expect(await recentFacets(db(), projectId)).toEqual({
      names: ["answer-question", "summarize-thread"],
      models: ["model-a", "model-b"],
      tags: ["chat", "dev", "prod"],
    });
  });

  it("exposes the same filters and sorts over REST and MCP", async () => {
    const rest = await callApi<TracePage>({
      path: "/api/v1/traces?sort=slowest&name=summarize-thread&limit=3",
      apiKey,
    });
    expect(rest.status).toBe(200);
    expect(ids(rest.body)).toEqual([29, 27, 25].map(idOf));
    const bad = await callApi<{ error: { code: string } }>({
      path: "/api/v1/traces?sort=slowest&sessionId=session-1",
      apiKey,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");

    const tool = await mcpTool(apiKey, "list_traces", { tag: "prod", sort: "costliest", limit: 3 });
    expect(tool.result?.isError).toBeFalsy();
    const structured = tool.result?.structuredContent as { traces: Array<{ id: string }> };
    expect(structured.traces.map((t) => t.id)).toEqual([27, 21, 15].map(idOf));
  });
});
