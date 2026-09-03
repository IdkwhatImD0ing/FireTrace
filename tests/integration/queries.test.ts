import "./env";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/firetrace/errors";
import { traceDocument } from "@/lib/firetrace/ingest";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { DEFAULT_PAGE_SIZE, listTraces, MAX_PAGE_SIZE } from "@/lib/firetrace/queries";
import type { IngestRequest } from "@/lib/firetrace/schema";
import { clearFirestore, createTestProject, db } from "./helpers";

const TOTAL = 120;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

interface Seeded {
  id: string;
  startedAt: string;
  status: "ok" | "error";
  model: string;
  sessionId: string;
}

/** 120 traces: three share each startedAt so the trace-id tie-breaker is exercised. */
function seedSpec(i: number): Seeded {
  return {
    id: i.toString(16).padStart(32, "0"),
    startedAt: new Date(BASE_MS + Math.floor(i / 3) * 60_000).toISOString(),
    status: i % 4 === 0 ? "error" : "ok",
    model: i % 3 === 0 ? "model-a" : "model-b",
    sessionId: i < 10 ? "session-early" : "session-late",
  };
}

function requestFor(spec: Seeded, i: number): IngestRequest {
  return {
    schemaVersion: 1,
    trace: {
      id: spec.id,
      name: `trace-${i}`,
      status: spec.status,
      startedAt: spec.startedAt,
      endedAt: new Date(Date.parse(spec.startedAt) + 1500).toISOString(),
      model: spec.model,
      sessionId: spec.sessionId,
      userId: i % 2 ? "user-odd" : "user-even",
      tags: [],
      metadata: {},
      usage: {},
      spans: [],
    },
  };
}

/** Newest first, then trace id descending: the exact order listTraces promises. */
function expectedOrder(filter: (s: Seeded) => boolean = () => true): string[] {
  return Array.from({ length: TOTAL }, (_, i) => seedSpec(i))
    .filter(filter)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id))
    .map((s) => s.id);
}

describe("listTraces cursor pagination and filters against the emulator", () => {
  let projectId = "";

  beforeAll(async () => {
    await clearFirestore();
    const project = await createTestProject("paged");
    projectId = project.id;
    const traces = db().collection("projects").doc(projectId).collection("traces");
    const batch = db().batch();
    for (let i = 0; i < TOTAL; i++) {
      const spec = seedSpec(i);
      const normalized = normalizeIngestBody(requestFor(spec, i));
      if (!normalized.ok) throw new Error(normalized.error.message);
      const { trace, bodyHash, estimatedBytes } = normalized.value;
      batch.set(traces.doc(trace.id), traceDocument(trace, bodyHash, estimatedBytes));
    }
    await batch.commit();
  });

  it("walks forward with `after` cursors without overlap or gaps", async () => {
    const expected = expectedOrder();
    const page1 = await listTraces(db(), projectId, {}, {});
    expect(page1.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(page1.traces).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page1.prevCursor).toBeNull();
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listTraces(db(), projectId, {}, { after: page1.nextCursor! });
    expect(page2.traces).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page2.prevCursor).not.toBeNull();
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listTraces(db(), projectId, {}, { after: page2.nextCursor! });
    expect(page3.traces).toHaveLength(TOTAL - 2 * DEFAULT_PAGE_SIZE);
    expect(page3.nextCursor).toBeNull();
    expect(page3.prevCursor).not.toBeNull();

    const walked = [...page1.traces, ...page2.traces, ...page3.traces].map((t) => t.id);
    expect(new Set(walked).size).toBe(TOTAL);
    expect(walked).toEqual(expected);
  });

  it("walks backward with `before` cursors and lands on exactly the same pages", async () => {
    const page1 = await listTraces(db(), projectId, {}, {});
    const page2 = await listTraces(db(), projectId, {}, { after: page1.nextCursor! });
    const page3 = await listTraces(db(), projectId, {}, { after: page2.nextCursor! });

    const back2 = await listTraces(db(), projectId, {}, { before: page3.prevCursor! });
    expect(back2.traces.map((t) => t.id)).toEqual(page2.traces.map((t) => t.id));
    expect(back2.prevCursor).not.toBeNull();
    expect(back2.nextCursor).toBe(page2.nextCursor);

    const back1 = await listTraces(db(), projectId, {}, { before: back2.prevCursor! });
    expect(back1.traces.map((t) => t.id)).toEqual(page1.traces.map((t) => t.id));
    expect(back1.prevCursor).toBeNull();
    expect(back1.nextCursor).toBe(page1.nextCursor);

    // Going "newer" from the very first page is a no-op rather than an error.
    const beforeFirst = await listTraces(
      db(),
      projectId,
      {},
      { before: page1.prevCursor ?? undefined },
    );
    expect(beforeFirst.traces.map((t) => t.id)).toEqual(page1.traces.map((t) => t.id));
  });

  it("honours custom page sizes, clamps to the maximum and rejects bad cursors", async () => {
    const small = await listTraces(db(), projectId, {}, { limit: 7 });
    expect(small.traces).toHaveLength(7);
    expect(small.traces.map((t) => t.id)).toEqual(expectedOrder().slice(0, 7));

    const clamped = await listTraces(db(), projectId, {}, { limit: 10_000 });
    expect(clamped.pageSize).toBe(MAX_PAGE_SIZE);
    expect(clamped.traces).toHaveLength(TOTAL);
    expect(clamped.nextCursor).toBeNull();

    await expect(listTraces(db(), projectId, {}, { after: "not-a-cursor" })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(listTraces(db(), projectId, {}, { after: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(listTraces(db(), projectId, {}, { before: "bm90LWpzb24" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("combines status and model filters", async () => {
    const both = await listTraces(db(), projectId, { status: "error", model: "model-a" }, {});
    const expected = expectedOrder((s) => s.status === "error" && s.model === "model-a");
    expect(expected).toHaveLength(10);
    expect(both.traces.map((t) => t.id)).toEqual(expected);
    for (const t of both.traces) {
      expect(t.status).toBe("error");
      expect(t.model).toBe("model-a");
    }

    const statusOnly = await listTraces(db(), projectId, { status: "error" }, {});
    expect(statusOnly.traces).toHaveLength(30);
    const modelOnly = await listTraces(db(), projectId, { model: "model-a" }, {});
    expect(modelOnly.traces).toHaveLength(40);
    const none = await listTraces(db(), projectId, { status: "unset", model: "model-a" }, {});
    expect(none.traces).toEqual([]);
  });

  it("paginates a filtered list with the same cursors", async () => {
    const expected = expectedOrder((s) => s.status === "ok");
    expect(expected).toHaveLength(90);
    const page1 = await listTraces(db(), projectId, { status: "ok" }, {});
    expect(page1.traces).toHaveLength(DEFAULT_PAGE_SIZE);
    const page2 = await listTraces(db(), projectId, { status: "ok" }, { after: page1.nextCursor! });
    expect(page2.traces).toHaveLength(40);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.traces, ...page2.traces].map((t) => t.id)).toEqual(expected);
    const back = await listTraces(db(), projectId, { status: "ok" }, { before: page2.prevCursor! });
    expect(back.traces.map((t) => t.id)).toEqual(page1.traces.map((t) => t.id));
  });

  it("filters by session, user and inclusive time range", async () => {
    const early = await listTraces(db(), projectId, { sessionId: "session-early" }, {});
    expect(early.traces.map((t) => t.id)).toEqual(
      expectedOrder((s) => s.sessionId === "session-early"),
    );

    const odd = await listTraces(db(), projectId, { userId: "user-odd" }, { limit: MAX_PAGE_SIZE });
    expect(odd.traces).toHaveLength(60);
    expect(odd.traces.every((t) => t.userId === "user-odd")).toBe(true);

    const from = seedSpec(30).startedAt; // minute 10
    const to = seedSpec(45).startedAt; // minute 15 (inclusive)
    const window = await listTraces(db(), projectId, { from, to }, {});
    const inWindow = expectedOrder(
      (s) =>
        Date.parse(s.startedAt) >= Date.parse(from) && Date.parse(s.startedAt) <= Date.parse(to),
    );
    expect(inWindow).toHaveLength(18);
    expect(window.traces.map((t) => t.id)).toEqual(inWindow);
  });
});
