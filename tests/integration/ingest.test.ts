import "./env";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { revokeApiKey } from "@/lib/firetrace/projects";
import { listTraces } from "@/lib/firetrace/queries";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { LIMITS } from "@/lib/firetrace/schema";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  postTrace,
  projectData,
  spanDocs,
  spanPathsUnderProject,
  traceData,
  traceIds,
} from "./helpers";

function normalized(body: ReturnType<typeof sampleTraceRequest>) {
  const result = normalizeIngestBody(body);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("POST /api/v1/traces against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("stores one trace and every span in the key's project and updates counters transactionally", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const body = sampleTraceRequest();
    const expected = normalized(body);

    const res = await postTrace(body, key.plaintext);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      traceId: body.trace.id,
      projectId: project.id,
      spanCount: body.trace.spans.length,
      duplicate: false,
    });
    expect(typeof res.body.requestId).toBe("string");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe(res.body.requestId);

    const trace = await traceData(project.id, body.trace.id);
    expect(trace).not.toBeNull();
    expect(trace?.bodyHash).toBe(expected.bodyHash);
    expect(trace?.name).toBe("answer-question");
    expect(trace?.status).toBe("ok");
    expect(trace?.spanCount).toBe(5);
    expect(trace?.errorCount).toBe(1);
    expect(trace?.estimatedBytes).toBe(expected.estimatedBytes);
    expect(trace?.startedAt).toBeInstanceOf(Timestamp);
    expect((trace?.startedAt as Timestamp).toDate().toISOString()).toBe(body.trace.startedAt);
    expect(trace?.ingestedAt).toBeInstanceOf(Timestamp);
    expect(trace?.input).toEqual(body.trace.input);
    expect(trace?.output).toEqual(body.trace.output);

    const spans = await spanDocs(project.id, body.trace.id);
    expect(spans.map((s) => s.id)).toEqual(body.trace.spans.map((s) => s.id).sort());
    for (const span of spans) {
      expect(span.data.traceId).toBe(body.trace.id);
      expect(span.data.startedAt).toBeInstanceOf(Timestamp);
    }
    const tool = spans.find((s) => s.id === "b7ad6b7169203331");
    expect(tool?.data.kind).toBe("tool");
    expect(tool?.data.status).toBe("error");
    expect(tool?.data.events).toHaveLength(2);
    expect(tool?.data.events[0].timestamp).toBeInstanceOf(Timestamp);

    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(1);
    expect(counters.spanCount).toBe(5);
    expect(counters.estimatedBytes).toBe(expected.estimatedBytes);
    expect((counters.lastTraceAt as Timestamp).toDate().toISOString()).toBe(body.trace.startedAt);
  });

  it("returns 200 duplicate:true for an identical retry and does not double the counters", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const body = sampleTraceRequest();
    const expected = normalized(body);

    const first = await postTrace(body, key.plaintext);
    expect(first.status).toBe(201);

    const retry = await postTrace(body, key.plaintext);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, traceId: body.trace.id, duplicate: true });

    // Same content with a different key order still hashes identically.
    const { spans, name, id, ...rest } = body.trace;
    const reordered = { trace: { spans, name, id, ...rest }, schemaVersion: body.schemaVersion };
    const reorderedRetry = await postTrace(reordered, key.plaintext);
    expect(reorderedRetry.status).toBe(200);
    expect(reorderedRetry.body.duplicate).toBe(true);

    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(1);
    expect(counters.spanCount).toBe(5);
    expect(counters.estimatedBytes).toBe(expected.estimatedBytes);
    expect(await traceIds(project.id)).toEqual([body.trace.id]);
    expect(await spanDocs(project.id, body.trace.id)).toHaveLength(5);
  });

  it("returns 409 trace_id_conflict when the same trace id carries different content", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const original = sampleTraceRequest();
    expect((await postTrace(original, key.plaintext)).status).toBe(201);

    const changed = sampleTraceRequest({ name: "something-else" });
    const res = await postTrace(changed, key.plaintext);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("trace_id_conflict");
    expect(res.body.error?.requestId).toBe(res.headers.get("x-request-id"));

    const stored = await traceData(project.id, original.trace.id);
    expect(stored?.name).toBe("answer-question");
    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(1);
    expect(counters.spanCount).toBe(5);
  });

  it("rejects missing, malformed, unknown, tampered and revoked keys with 401 and writes nothing", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const body = sampleTraceRequest();
    const [keyId, secret] = key.plaintext.replace(/^ft_live_/, "").split("_");
    const tamperedSecret = `${secret.slice(0, -1)}${secret.endsWith("0") ? "1" : "0"}`;

    const attempts: Array<[label: string, headers: Record<string, string>]> = [
      ["missing header", {}],
      ["empty bearer", { authorization: "Bearer " }],
      ["wrong scheme", { authorization: `Basic ${key.plaintext}` }],
      ["not a key", { authorization: "Bearer not-a-key" }],
      ["unknown key id", { authorization: `Bearer ft_live_${"0".repeat(16)}_${secret}` }],
      ["wrong secret", { authorization: `Bearer ft_live_${keyId}_${tamperedSecret}` }],
    ];
    for (const [label, headers] of attempts) {
      const res = await postTrace(body, null, headers);
      expect(res.status, label).toBe(401);
      expect(res.body.error?.code, label).toBe("invalid_api_key");
    }

    // Revocation takes effect immediately.
    expect((await postTrace(body, key.plaintext)).status).toBe(201);
    await revokeApiKey(db(), project.id, key.key.id);
    const revoked = await postTrace(sampleTraceRequest({ id: "f".repeat(32) }), key.plaintext);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error?.code).toBe("invalid_api_key");

    expect(await traceIds(project.id)).toEqual([body.trace.id]);
    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(1);
  });

  it("keeps projects isolated: a key for project A cannot write into project B", async () => {
    const alpha = await createTestProject("alpha");
    const beta = await createTestProject("beta");
    const alphaKey = await createTestKey(alpha.id);
    const body = sampleTraceRequest();

    const res = await postTrace(body, alphaKey.plaintext);
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(alpha.id);

    expect(await traceIds(alpha.id)).toEqual([body.trace.id]);
    expect(await traceIds(beta.id)).toEqual([]);
    expect(await spanPathsUnderProject(alpha.id)).toHaveLength(5);
    expect(await spanPathsUnderProject(beta.id)).toHaveLength(0);

    const betaPage = await listTraces(db(), beta.id, {}, {});
    expect(betaPage.traces).toEqual([]);
    expect(betaPage.nextCursor).toBeNull();
    const alphaPage = await listTraces(db(), alpha.id, {}, {});
    expect(alphaPage.traces.map((t) => t.id)).toEqual([body.trace.id]);

    expect((await projectData(alpha.id)).traceCount).toBe(1);
    expect((await projectData(beta.id)).traceCount).toBe(0);
    expect((await projectData(beta.id)).spanCount).toBe(0);
  });

  it("rejects oversize payloads with 413 and leaves no partial writes", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);

    // Trace document above the 750 KiB normalized limit, request below 2 MiB.
    const bigTrace = sampleTraceRequest();
    bigTrace.trace.input = { prompt: "x".repeat(LIMITS.maxDocumentBytes + 1024) };
    const traceTooBig = await postTrace(bigTrace, key.plaintext);
    expect(traceTooBig.status).toBe(413);
    expect(traceTooBig.body.error?.code).toBe("payload_too_large");

    // One span above the per-document limit while the trace document itself is small.
    const bigSpan = sampleTraceRequest({ id: "b".repeat(32) });
    bigSpan.trace.spans[1].input = { messages: "y".repeat(LIMITS.maxDocumentBytes + 1024) };
    const spanTooBig = await postTrace(bigSpan, key.plaintext);
    expect(spanTooBig.status).toBe(413);
    expect(spanTooBig.body.error?.code).toBe("payload_too_large");

    // Request body above 2 MiB is rejected before parsing.
    const huge = sampleTraceRequest({ id: "c".repeat(32) });
    huge.trace.input = { prompt: "z".repeat(LIMITS.maxRequestBytes + 1024) };
    const requestTooBig = await postTrace(huge, key.plaintext);
    expect(requestTooBig.status).toBe(413);
    expect(requestTooBig.body.error?.code).toBe("payload_too_large");

    expect(await traceIds(project.id)).toEqual([]);
    expect(await spanPathsUnderProject(project.id)).toHaveLength(0);
    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(0);
    expect(counters.spanCount).toBe(0);
    expect(counters.estimatedBytes).toBe(0);
  });

  it("returns 400 for malformed JSON and schema violations without writing", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);

    const badJson = await postTrace("{not json", key.plaintext);
    expect(badJson.status).toBe(400);
    expect(badJson.body.error?.code).toBe("invalid_json");

    const orphanParent = sampleTraceRequest();
    orphanParent.trace.spans[1].parentSpanId = "0000000000000000";
    const badSchema = await postTrace(orphanParent, key.plaintext);
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error?.code).toBe("invalid_trace");

    const unknownField = { ...sampleTraceRequest(), extra: true };
    const strict = await postTrace(unknownField, key.plaintext);
    expect(strict.status).toBe(400);
    expect(strict.body.error?.code).toBe("invalid_trace");

    expect(await traceIds(project.id)).toEqual([]);
    expect((await projectData(project.id)).traceCount).toBe(0);
  });

  it("normalizes uppercase hex ids to lowercase before storing", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const body = sampleTraceRequest({ id: "ABCDEF0123456789ABCDEF0123456789" });
    body.trace.spans[0].id = "00F067AA0BA902B7";
    for (const span of body.trace.spans.slice(1)) span.parentSpanId = "00F067AA0BA902B7";

    const res = await postTrace(body, key.plaintext);
    expect(res.status).toBe(201);
    expect(res.body.traceId).toBe("abcdef0123456789abcdef0123456789");
    expect(await traceIds(project.id)).toEqual(["abcdef0123456789abcdef0123456789"]);
    const spans = await spanDocs(project.id, "abcdef0123456789abcdef0123456789");
    expect(spans.map((s) => s.id)).toContain("00f067aa0ba902b7");
    expect(spans.find((s) => s.id === "3c1f5a9e8b2d4c60")?.data.parentSpanId).toBe(
      "00f067aa0ba902b7",
    );
  });
});
