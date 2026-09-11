import "./env";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { createEvaluator } from "@/lib/eval/evaluators";
import { runEvaluator } from "@/lib/eval/run";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { createApiKey, createProject, deleteTrace } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { LIMITS, type IngestRequest, type SpanInput } from "@/lib/firetrace/schema";
import { getTrialUsage, trialSubject } from "@/lib/firetrace/trial";
import { callApi } from "./api-helpers";
import { TEST_PEPPER } from "./env";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  postTrace,
  projectData,
  spanDocs,
  traceData,
} from "./helpers";

// Trial mode on for this module (its own module graph), as in trial-accounting.test.ts.
process.env.FIRETRACE_TRIAL_TRACE_LIMIT = "3";

const T1 = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const T2 = "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2";
const DAY = "2026-09-02"; // sampleTraceRequest() starts at 2026-09-02T19:01:02.120Z
const END = "2026-09-02T19:01:05.000Z";
const GUEST_EMAIL = "stream-guest@example.com";

/** The sample trace as a running start: no endedAt, no status, only the given spans. */
function startBody(id = T1, spans: SpanInput[] = []): IngestRequest {
  const body = sampleTraceRequest({ id });
  delete body.trace.endedAt;
  delete body.trace.status;
  delete body.trace.output;
  delete body.trace.costUsd;
  body.trace.spans = spans;
  return body;
}

function sampleSpans(): SpanInput[] {
  return sampleTraceRequest().trace.spans;
}

function syntheticSpan(index: number): SpanInput {
  return {
    id: index.toString(16).padStart(16, "0"),
    parentSpanId: null,
    name: `s-${index}`,
    kind: "custom",
    status: "ok",
    startedAt: "2026-09-02T19:01:02.200Z",
    endedAt: "2026-09-02T19:01:02.300Z",
    attributes: {},
    events: [],
  };
}

async function day(projectId: string, collection = "stats", id = DAY) {
  const snap = await db()
    .collection("projects")
    .doc(projectId)
    .collection(collection)
    .doc(id)
    .get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

function spans(apiKey: string, traceId: string, batch: SpanInput[]) {
  return callApi<Record<string, unknown> & { error?: { code: string; message: string } }>({
    method: "POST",
    path: `/api/v1/traces/${traceId}/spans`,
    apiKey,
    body: { schemaVersion: 1, spans: batch },
  });
}

function end(apiKey: string, traceId: string, body: Record<string, unknown>) {
  return callApi<Record<string, unknown> & { error?: { code: string; message: string } }>({
    method: "POST",
    path: `/api/v1/traces/${traceId}/end`,
    apiKey,
    body: { schemaVersion: 1, endedAt: END, ...body },
  });
}

describe("streamed ingestion against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("start, spans, end: visible while running, counted, and rolled up only at the end", async () => {
    const project = await createTestProject("stream");
    const key = await createTestKey(project.id);
    const all = sampleSpans();
    const startBodyValue = startBody(T1, [all[0]]);
    const startHash = (() => {
      const result = normalizeIngestBody(startBodyValue);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.bodyHash;
    })();

    const started = await postTrace(startBodyValue, key.plaintext);
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({
      ok: true,
      traceId: T1,
      spanCount: 1,
      duplicate: false,
      running: true,
    });
    let doc = (await traceData(project.id, T1))!;
    expect(doc.status).toBe("running");
    expect(doc).not.toHaveProperty("endedAt");
    expect(doc).not.toHaveProperty("durationMs");
    expect(doc.bodyHash).toBe(startHash);
    expect(doc.spanCount).toBe(1);
    expect(await day(project.id)).toBeNull();
    let counters = await projectData(project.id);
    expect(counters).toMatchObject({ traceCount: 1, spanCount: 1 });
    expect(counters.lastTraceAt).toBeInstanceOf(Timestamp);
    expect(counters.estimatedBytes).toBe(doc.estimatedBytes);

    // Children arrive before their parent finishes: a parent outside the batch is fine.
    const first = await spans(key.plaintext, T1, [all[1], all[2]]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      traceId: T1,
      added: 2,
      duplicate: 0,
      spanCount: 3,
    });
    // A retry that mixes stored and new spans writes only the new one.
    const second = await spans(key.plaintext, T1, [all[2], all[3]]);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ added: 1, duplicate: 1, spanCount: 4 });
    doc = (await traceData(project.id, T1))!;
    expect(doc.spanCount).toBe(4);
    expect(doc.errorCount).toBe(all.slice(0, 4).filter((s) => s.status === "error").length);
    counters = await projectData(project.id);
    expect(counters.spanCount).toBe(4);
    expect(counters.estimatedBytes).toBe(doc.estimatedBytes);
    const bytesBeforeEnd = counters.estimatedBytes as number;
    for (const span of await spanDocs(project.id, T1)) {
      expect(span.data.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }

    const running = await callApi<{ trace: Record<string, unknown> }>({
      path: `/api/v1/traces/${T1}`,
      apiKey: key.plaintext,
    });
    expect(running.body.trace).toMatchObject({
      status: "running",
      endedAt: null,
      durationMs: null,
      spanCount: 4,
    });
    const listed = await callApi<{ traces: Array<{ id: string; status: string }> }>({
      path: "/api/v1/traces?status=running",
      apiKey: key.plaintext,
    });
    expect(listed.body.traces.map((t) => t.id)).toEqual([T1]);

    const ended = await end(key.plaintext, T1, {
      status: "error",
      output: { text: "partial" },
      usage: { inputTokens: 5, outputTokens: 7 },
      costUsd: 0.25,
      metadata: { outcome: "crash" },
      tags: ["late"],
      spans: [all[4]],
    });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ ok: true, traceId: T1, duplicate: false, spanCount: 5 });
    doc = (await traceData(project.id, T1))!;
    const durationMs = Date.parse(END) - Date.parse(startBodyValue.trace.startedAt);
    expect(doc.status).toBe("error");
    expect((doc.endedAt as Timestamp).toDate().toISOString()).toBe(END);
    expect(doc.durationMs).toBe(durationMs);
    expect(doc.spanCount).toBe(5);
    expect(doc.errorCount).toBe(all.filter((s) => s.status === "error").length);
    expect(doc.output).toEqual({ text: "partial" });
    expect(doc.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(doc.costUsd).toBe(0.25);
    expect(doc.metadata).toEqual({ ...startBodyValue.trace.metadata, outcome: "crash" });
    expect(doc.tags).toEqual([...startBodyValue.trace.tags, "late"]);
    expect(doc.endHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.bodyHash).toBe(startHash);
    expect((await spanDocs(project.id, T1)).map((s) => s.id)).toEqual(all.map((s) => s.id).sort());
    counters = await projectData(project.id);
    expect(counters).toMatchObject({ traceCount: 1, spanCount: 5 });
    expect(counters.estimatedBytes).toBe(doc.estimatedBytes);
    expect(counters.estimatedBytes).toBeGreaterThan(bytesBeforeEnd);

    expect(await day(project.id)).toMatchObject({
      traces: 1,
      errors: 1,
      spans: 5,
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      costUsd: 0.25,
      durationMsSum: durationMs,
    });
    expect(await day(project.id, "statsByEnv", `_unassigned:${DAY}`)).toMatchObject({ traces: 1 });

    const finished = await callApi<{ trace: Record<string, unknown> }>({
      path: `/api/v1/traces/${T1}`,
      apiKey: key.plaintext,
    });
    expect(finished.body.trace).toMatchObject({ status: "error", endedAt: END, durationMs });
    const none = await callApi<{ traces: unknown[] }>({
      path: "/api/v1/traces?status=running",
      apiKey: key.plaintext,
    });
    expect(none.body.traces).toEqual([]);
  });

  it("every step is idempotent on retry, and a different body is a 409 that writes nothing", async () => {
    const project = await createTestProject("retries");
    const key = await createTestKey(project.id);
    const all = sampleSpans();
    const body = startBody(T1, [all[0]]);

    expect((await postTrace(body, key.plaintext)).status).toBe(201);
    const again = await postTrace(body, key.plaintext);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, running: true });
    const renamed = startBody(T1, [all[0]]);
    renamed.trace.name = "something-else";
    const conflict = await postTrace(renamed, key.plaintext);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("trace_id_conflict");

    expect((await spans(key.plaintext, T1, [all[1]])).body).toMatchObject({ added: 1 });
    expect((await spans(key.plaintext, T1, [all[1]])).body).toMatchObject({
      added: 0,
      duplicate: 1,
      spanCount: 2,
    });
    const changed = { ...all[1], name: "renamed-span" };
    const spanConflict = await spans(key.plaintext, T1, [changed, all[2]]);
    expect(spanConflict.status).toBe(409);
    expect(spanConflict.body.error?.code).toBe("span_conflict");
    expect((await traceData(project.id, T1))?.spanCount).toBe(2);
    expect((await spanDocs(project.id, T1)).find((s) => s.id === all[1].id)?.data.name).toBe(
      all[1].name,
    );

    const endBody = { status: "ok", output: { text: "done" } };
    expect((await end(key.plaintext, T1, endBody)).body).toMatchObject({ duplicate: false });
    const endAgain = await end(key.plaintext, T1, endBody);
    expect(endAgain.status).toBe(200);
    expect(endAgain.body).toMatchObject({ duplicate: true, spanCount: 2 });
    const endChanged = await end(key.plaintext, T1, { status: "error" });
    expect(endChanged.status).toBe(409);
    expect(endChanged.body.error?.code).toBe("trace_finished");
    const late = await spans(key.plaintext, T1, [all[2]]);
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe("trace_finished");
    expect((await traceData(project.id, T1))?.status).toBe("ok");
    const rolled = await day(project.id);
    expect(rolled).toMatchObject({ traces: 1, spans: 2 });
    expect(rolled?.errors ?? 0).toBe(0); // zero deltas are never written
    // The start is still recognised after the end: bodyHash describes the body as ingested.
    expect((await postTrace(body, key.plaintext)).status).toBe(200);
  });

  it("refuses spans and end for unknown traces and validates the bodies", async () => {
    const project = await createTestProject("validation");
    const key = await createTestKey(project.id);
    const all = sampleSpans();

    expect((await spans(key.plaintext, T2, [all[0]])).status).toBe(404);
    expect((await end(key.plaintext, T2, {})).status).toBe(404);
    expect((await spans(key.plaintext, "not-a-trace", [all[0]])).status).toBe(404);

    const withStatus = startBody(T1);
    withStatus.trace.status = "ok";
    const rejected = await postTrace(withStatus, key.plaintext);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe("invalid_trace");
    expect(rejected.body.error?.message).toMatch(/status is decided by the end request/);

    expect((await postTrace(startBody(T1), key.plaintext)).status).toBe(201);
    const empty = await spans(key.plaintext, T1, []);
    expect(empty.status).toBe(400);
    const early = await end(key.plaintext, T1, { endedAt: "2026-09-02T19:01:01.000Z" });
    expect(early.status).toBe(400);
    expect(early.body.error?.message).toMatch(/endedAt cannot precede/);
    expect((await traceData(project.id, T1))?.status).toBe("running");
  });

  it(`caps a streamed trace at ${LIMITS.maxSpans} spans in total`, async () => {
    const project = await createTestProject("cap");
    const key = await createTestKey(project.id);
    const initial = Array.from({ length: LIMITS.maxSpans - 1 }, (_, i) => syntheticSpan(i + 1));
    expect((await postTrace(startBody(T1, initial), key.plaintext)).status).toBe(201);

    const over = await spans(key.plaintext, T1, [
      syntheticSpan(LIMITS.maxSpans),
      syntheticSpan(LIMITS.maxSpans + 1),
    ]);
    expect(over.status).toBe(400);
    expect(over.body.error?.message).toMatch(new RegExp(`limit is ${LIMITS.maxSpans}`));
    expect((await traceData(project.id, T1))?.spanCount).toBe(LIMITS.maxSpans - 1);

    const last = await spans(key.plaintext, T1, [syntheticSpan(LIMITS.maxSpans)]);
    expect(last.status).toBe(200);
    expect(last.body).toMatchObject({ added: 1, spanCount: LIMITS.maxSpans });
    const overAtEnd = await end(key.plaintext, T1, { spans: [syntheticSpan(LIMITS.maxSpans + 1)] });
    expect(overAtEnd.status).toBe(400);
    expect((await traceData(project.id, T1))?.status).toBe("running");
  });

  it("deleting a running trace returns the counters and leaves the day's rollup untouched", async () => {
    const project = await createTestProject("delete");
    const key = await createTestKey(project.id);
    const all = sampleSpans();
    expect((await postTrace(startBody(T1, [all[0], all[1]]), key.plaintext)).status).toBe(201);

    await deleteTrace(db(), project.id, T1);
    expect(await traceData(project.id, T1)).toBeNull();
    expect(await spanDocs(project.id, T1)).toEqual([]);
    expect(await projectData(project.id)).toMatchObject({
      traceCount: 0,
      spanCount: 0,
      estimatedBytes: 0,
    });
    expect(await day(project.id)).toBeNull();
  });

  it("a trial account pays for a streamed trace once, at the start", async () => {
    const project = await createProject(db(), {
      name: "trial-stream",
      ownerUid: "stream-guest",
      ownerEmail: GUEST_EMAIL,
      plan: "trial",
    });
    const key = await createApiKey(db(), {
      projectId: project.id,
      label: "k",
      createdByUid: "stream-guest",
      pepper: TEST_PEPPER,
    });
    const all = sampleSpans();
    const used = () => getTrialUsage(db(), trialSubject(GUEST_EMAIL)).then((u) => u.tracesUsed);

    expect((await postTrace(startBody(T1), key.plaintext)).status).toBe(201);
    expect(await used()).toBe(1);
    expect((await spans(key.plaintext, T1, [all[0]])).status).toBe(200);
    expect(await used()).toBe(1);
    expect((await end(key.plaintext, T1, { status: "ok" })).status).toBe(200);
    expect(await used()).toBe(1);
  });

  it("evaluators skip a trace that is still running", async () => {
    const project = await createTestProject("evals");
    const key = await createTestKey(project.id);
    expect((await postTrace(startBody(T1), key.plaintext)).status).toBe(201);
    const evaluator = await createEvaluator(db(), project.id, {
      name: "helpful",
      description: "Was the answer helpful?",
      promptTemplate: "Q: {{input}}\nA: {{output}}\nWas this helpful?",
      outputType: { kind: "boolean" },
    });
    const judgeCalls: unknown[] = [];
    const fetchImpl = (async () => {
      judgeCalls.push(1);
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;

    const outcome = await runEvaluator(
      db(),
      { baseUrl: "https://judge.test/v1", apiKey: "sk-judge", model: "judge" },
      project.id,
      evaluator,
      T1,
      { trigger: "manual", fetchImpl, retryDelayMs: 0 },
    );
    expect(outcome).toEqual({ status: "skipped", runId: null, reason: "trace is still running" });
    expect(judgeCalls).toHaveLength(0);
  });
});
