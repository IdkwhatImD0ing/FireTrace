import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import type { JsonObject } from "@/lib/firetrace/schema";
import type { SpanDetail, TraceDetail } from "@/lib/firetrace/types";
import { callApi } from "./api-helpers";
import { TEST_PEPPER } from "./env";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  OWNER_UID,
  postTrace,
  projectData,
  spanDocs,
  traceData,
} from "./helpers";

type ErrorBody = { error: { code: string; message: string; requestId: string } };
type PatchResult = {
  ok: boolean;
  traceId: string;
  metadata: JsonObject;
  changed: boolean;
  requestId: string;
};

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const MISSING = "0000000000000000000000000000dead";

function patch(traceId: string, apiKey: string | null, body: unknown) {
  return callApi<PatchResult & ErrorBody>({
    method: "PATCH",
    path: `/api/v1/traces/${traceId}`,
    apiKey,
    body,
  });
}

async function seed(name = "alpha") {
  const project = await createTestProject(name);
  const key = await createTestKey(project.id, "patcher");
  expect((await postTrace(sampleTraceRequest({ id: T1 }), key.plaintext)).status).toBe(201);
  return { project, apiKey: key.plaintext };
}

describe("PATCH /api/v1/traces/{traceId} against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("merges keys into metadata and leaves the rest of the trace alone", async () => {
    const { project, apiKey } = await seed();
    const before = await traceData(project.id, T1);
    const spansBefore = await spanDocs(project.id, T1);

    const res = await patch(T1, apiKey, { metadata: { feedback: 1, label: "thumbs-up" } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.metadata).toMatchObject({ feedback: 1, label: "thumbs-up" });
    // The trace was ingested with metadata of its own; the patch adds to it.
    expect(res.body.metadata).toMatchObject(
      (sampleTraceRequest().trace.metadata ?? {}) as JsonObject,
    );

    const after = await traceData(project.id, T1);
    expect(after).toBeTruthy();
    for (const field of [
      "name",
      "status",
      "startedAt",
      "endedAt",
      "durationMs",
      "model",
      "provider",
      "sessionId",
      "userId",
      "input",
      "output",
      "usage",
      "spanCount",
      "errorCount",
      "ingestedAt",
    ]) {
      expect(after![field]).toEqual(before![field]);
    }
    expect(await spanDocs(project.id, T1)).toEqual(spansBefore);
  });

  it("leaves bodyHash alone so re-sending the original trace is still a duplicate", async () => {
    const { project, apiKey } = await seed();
    const hashBefore = (await traceData(project.id, T1))!.bodyHash;

    expect((await patch(T1, apiKey, { metadata: { feedback: 0 } })).status).toBe(200);
    expect((await traceData(project.id, T1))!.bodyHash).toBe(hashBefore);

    const resend = await postTrace(sampleTraceRequest({ id: T1 }), apiKey);
    expect(resend.status).toBe(200);
    expect(resend.body.duplicate).toBe(true);
  });

  it("merges shallowly: a patched key replaces that key outright", async () => {
    const { apiKey } = await seed();
    await patch(T1, apiKey, { metadata: { review: { verdict: "wrong", by: "sam" } } });
    const res = await patch(T1, apiKey, { metadata: { review: { verdict: "right" } } });
    expect(res.body.metadata.review).toEqual({ verdict: "right" });
  });

  it("overwrites a repeated key, last writer wins", async () => {
    const { apiKey } = await seed();
    expect((await patch(T1, apiKey, { metadata: { feedback: 1 } })).body.metadata.feedback).toBe(1);
    expect((await patch(T1, apiKey, { metadata: { feedback: 0 } })).body.metadata.feedback).toBe(0);
  });

  it("reports changed:false and writes nothing when the merge changes nothing", async () => {
    const { project, apiKey } = await seed();
    await patch(T1, apiKey, { metadata: { feedback: 1 } });
    const stamped = (await traceData(project.id, T1))!.metadataUpdatedAt;

    const repeat = await patch(T1, apiKey, { metadata: { feedback: 1 } });
    expect(repeat.status).toBe(200);
    expect(repeat.body.changed).toBe(false);
    expect((await traceData(project.id, T1))!.metadataUpdatedAt).toEqual(stamped);

    const empty = await patch(T1, apiKey, { metadata: {} });
    expect(empty.body.changed).toBe(false);
  });

  it("404s for an unknown trace and for a trace in another project", async () => {
    const { apiKey } = await seed("alpha");
    const other = await createTestProject("beta");
    const otherKey = await createTestKey(other.id, "beta-patcher");

    const unknown = await patch(MISSING, apiKey, { metadata: { feedback: 1 } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("not_found");
    expect(unknown.body.error.requestId).toMatch(/^[0-9a-f]{16}$/);

    const crossProject = await patch(T1, otherKey.plaintext, { metadata: { feedback: 1 } });
    expect(crossProject.status).toBe(404);
    expect(crossProject.body.error.code).toBe("not_found");
  });

  it("refuses anything but a metadata patch, naming the field", async () => {
    const { project, apiKey } = await seed();
    const renamed = await patch(T1, apiKey, { metadata: {}, name: "renamed" });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error.code).toBe("invalid_request");
    expect(renamed.body.error.message).toContain("name");

    expect((await patch(T1, apiKey, { name: "renamed" })).status).toBe(400);
    expect((await patch(T1, apiKey, "not json")).status).toBe(400);
    expect((await patch(T1, apiKey, { metadata: "thumbs-up" })).status).toBe(400);
    expect((await traceData(project.id, T1))!.name).toBe(sampleTraceRequest().trace.name);
  });

  it("needs traces:write, not traces:read", async () => {
    const { project } = await seed();
    const readOnly = await createApiKey(db(), {
      projectId: project.id,
      label: "reader",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:read"],
    });
    const res = await patch(T1, readOnly.plaintext, { metadata: { feedback: 1 } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");

    const anonymous = await patch(T1, null, { metadata: { feedback: 1 } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("shows the merged metadata on the read path and keeps the storage estimate honest", async () => {
    const { project, apiKey } = await seed();
    const bytesBefore = (await projectData(project.id)).estimatedBytes;

    await patch(T1, apiKey, { metadata: { feedback: 0, comment: "cited the wrong page" } });

    const res = await callApi<{ trace: TraceDetail; spans: SpanDetail[] }>({
      path: `/api/v1/traces/${T1}`,
      apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.body.trace.metadata).toMatchObject({
      feedback: 0,
      comment: "cited the wrong page",
    });
    expect(res.body.trace.metadataUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.spans.length).toBeGreaterThan(0);

    const after = await projectData(project.id);
    expect(after.estimatedBytes).toBeGreaterThan(bytesBefore);
    expect(after.estimatedBytes).toBe((await traceData(project.id, T1))!.estimatedBytes);
  });

  it("gives back the storage on delete, patched bytes included", async () => {
    const { project, apiKey } = await seed();
    await patch(T1, apiKey, { metadata: { comment: "x".repeat(500) } });
    const deleter = await createApiKey(db(), {
      projectId: project.id,
      label: "deleter",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:delete"],
    });
    const deleted = await callApi({
      method: "DELETE",
      path: `/api/v1/traces/${T1}`,
      apiKey: deleter.plaintext,
    });
    expect(deleted.status).toBe(200);
    const after = await projectData(project.id);
    expect(after.traceCount).toBe(0);
    expect(after.estimatedBytes).toBe(0);
  });

  it("keeps both writes when two patches race on different keys", async () => {
    const { apiKey } = await seed();
    const [a, b] = await Promise.all([
      patch(T1, apiKey, { metadata: { feedback: 1 } }),
      patch(T1, apiKey, { metadata: { review: "approved" } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const res = await callApi<{ trace: TraceDetail }>({
      path: `/api/v1/traces/${T1}`,
      apiKey,
    });
    expect(res.body.trace.metadata).toMatchObject({ feedback: 1, review: "approved" });
  });
});
