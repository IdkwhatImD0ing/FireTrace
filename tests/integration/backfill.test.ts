import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/backfill-feedback-metadata";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import type { IngestRequest } from "@/lib/firetrace/schema";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  postTrace,
  projectData,
  traceData,
  traceIds,
} from "./helpers";

const REAL = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const FAKE = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const ORPHAN_FAKE = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const GONE = "dddddddddddddddddddddddddddddddd";

/** The legacy workaround: a second, zero-duration trace pointing at the real one. */
function feedbackTrace(id: string, feedbackFor: string): IngestRequest {
  const at = sampleTraceRequest().trace.startedAt;
  return {
    schemaVersion: 1,
    trace: {
      id,
      name: "user-feedback",
      status: "ok",
      startedAt: at,
      endedAt: at,
      tags: [],
      usage: {},
      metadata: { feedbackFor, rating: "down", comment: "cited the wrong page" },
      spans: [],
    },
  };
}

async function seed() {
  const project = await createTestProject("legacy");
  const key = await createTestKey(project.id, "backfill");
  expect((await postTrace(sampleTraceRequest({ id: REAL }), key.plaintext)).status).toBe(201);
  expect((await postTrace(feedbackTrace(FAKE, REAL), key.plaintext)).status).toBe(201);
  return project;
}

describe("feedback backfill against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("reports what it would do and writes nothing on a dry run", async () => {
    const project = await seed();
    const before = await traceData(project.id, REAL);

    const report = await migrate(db(), { projectId: project.id, apply: false, log: noop });
    expect(report).toMatchObject({ scanned: 2, migrated: 1, deleted: 0, orphaned: 0, failed: 0 });

    expect(await traceData(project.id, REAL)).toEqual(before);
    expect((await traceIds(project.id)).sort()).toEqual([REAL, FAKE].sort());
  });

  it("folds the stand-in into its target and deletes it", async () => {
    const project = await seed();
    const countBefore = (await projectData(project.id)).traceCount;

    const report = await migrate(db(), { projectId: project.id, apply: true, log: noop });
    expect(report).toMatchObject({ scanned: 2, migrated: 1, deleted: 1, orphaned: 0, failed: 0 });

    const target = await traceData(project.id, REAL);
    expect(target!.metadata).toMatchObject({
      "feedback.rating": "down",
      "feedback.comment": "cited the wrong page",
      "feedback.migratedFrom": FAKE,
    });
    // The trace's own ingest-time metadata survives the merge.
    expect(target!.metadata).toMatchObject(sampleTraceRequest().trace.metadata ?? {});
    expect(target!.name).toBe(sampleTraceRequest().trace.name);

    expect(await traceData(project.id, FAKE)).toBeNull();
    expect(await traceIds(project.id)).toEqual([REAL]);
    expect((await projectData(project.id)).traceCount).toBe(countBefore - 1);
  });

  it("is safe to run twice", async () => {
    const project = await seed();
    await migrate(db(), { projectId: project.id, apply: true, log: noop });
    const afterFirst = await traceData(project.id, REAL);

    const second = await migrate(db(), {
      projectId: project.id,
      apply: true,
      log: noop,
    });
    expect(second).toMatchObject({ scanned: 1, migrated: 0, deleted: 0, failed: 0 });
    expect(await traceData(project.id, REAL)).toEqual(afterFirst);
  });

  it("leaves a stand-in alone when its target is already gone", async () => {
    const project = await createTestProject("orphans");
    const key = await createTestKey(project.id, "backfill");
    expect((await postTrace(feedbackTrace(ORPHAN_FAKE, GONE), key.plaintext)).status).toBe(201);

    const report = await migrate(db(), { projectId: project.id, apply: true, log: noop });
    expect(report).toMatchObject({ scanned: 1, migrated: 0, deleted: 0, orphaned: 1, failed: 0 });
    // Feedback is never destroyed just because it cannot be migrated.
    expect(await traceData(project.id, ORPHAN_FAKE)).not.toBeNull();
  });

  it("leaves ordinary traces untouched", async () => {
    const project = await createTestProject("ordinary");
    const key = await createTestKey(project.id, "backfill");
    await postTrace(sampleTraceRequest({ id: REAL }), key.plaintext);
    const before = await traceData(project.id, REAL);

    const report = await migrate(db(), { projectId: project.id, apply: true, log: noop });
    expect(report).toMatchObject({ scanned: 1, migrated: 0, deleted: 0, orphaned: 0 });
    expect(await traceData(project.id, REAL)).toEqual(before);
  });
});

function noop() {}
