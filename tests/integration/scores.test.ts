import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProject, deleteTrace } from "@/lib/firetrace/projects";
import { getTrace } from "@/lib/firetrace/queries";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { SCORE_LIMITS } from "@/lib/firetrace/schema";
import { addScore, deleteScore, listScores, listScoresForTrace } from "@/lib/firetrace/scores";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  postTrace,
  projectData,
  traceData,
} from "./helpers";

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const T2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const MISSING = "0000000000000000000000000000dead";

async function seed() {
  const project = await createTestProject("alpha");
  const key = await createTestKey(project.id, "scorer");
  expect((await postTrace(sampleTraceRequest({ id: T1 }), key.plaintext)).status).toBe(201);
  return { project, apiKey: key.plaintext };
}

async function scoreDocs(projectId: string) {
  const snap = await db().collection("projects").doc(projectId).collection("scores").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

describe("scores against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("stores the score, summarizes it on the trace and counts its bytes", async () => {
    const { project } = await seed();
    const bytesBefore = (await projectData(project.id)).estimatedBytes;
    const traceBytesBefore = (await traceData(project.id, T1))!.estimatedBytes;

    const score = await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 0.8, comment: "close enough" },
      { source: "annotation" },
    );
    expect(score).toMatchObject({
      traceId: T1,
      name: "accuracy",
      dataType: "numeric",
      value: 0.8,
      comment: "close enough",
      source: "annotation",
      evaluatorId: null,
      runId: null,
      spanId: null,
    });
    expect(score.id).toMatch(/^[0-9a-f]{16}$/);
    expect(score.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const docs = await scoreDocs(project.id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: score.id, name: "accuracy", value: 0.8 });

    const trace = (await getTrace(db(), project.id, T1))!;
    expect(trace.scores).toEqual({
      accuracy: { scoreId: score.id, dataType: "numeric", value: 0.8, evaluatorId: null },
    });

    const projectAfter = await projectData(project.id);
    const traceAfter = (await traceData(project.id, T1))!;
    expect(projectAfter.estimatedBytes).toBeGreaterThan(bytesBefore);
    expect(traceAfter.estimatedBytes - traceBytesBefore).toBe(
      projectAfter.estimatedBytes - bytesBefore,
    );
  });

  it("keeps the newest score per name on the trace and every score in the list", async () => {
    const { project } = await seed();
    const first = await addScore(
      db(),
      project.id,
      T1,
      { name: "helpful", dataType: "boolean", value: false },
      { source: "api" },
    );
    const second = await addScore(
      db(),
      project.id,
      T1,
      { name: "helpful", dataType: "boolean", value: true },
      { source: "eval", evaluatorId: "ev1", runId: "run1" },
    );
    await addScore(
      db(),
      project.id,
      T1,
      { name: "topic", dataType: "categorical", value: "billing" },
      { source: "api" },
    );

    const trace = (await getTrace(db(), project.id, T1))!;
    expect(trace.scores.helpful).toEqual({
      scoreId: second.id,
      dataType: "boolean",
      value: true,
      evaluatorId: "ev1",
    });
    expect(trace.scores.topic?.value).toBe("billing");

    const listed = await listScoresForTrace(db(), project.id, T1);
    expect(listed.map((s) => s.name)).toEqual(["topic", "helpful", "helpful"]);
    expect(listed[2].id).toBe(first.id);
    expect(listed[1]).toMatchObject({ evaluatorId: "ev1", runId: "run1", source: "eval" });
  });

  it("404s for a missing trace and 401s for a missing project", async () => {
    const { project } = await seed();
    const input = { name: "accuracy", dataType: "numeric", value: 1 } as const;
    await expect(
      addScore(db(), project.id, MISSING, input, { source: "api" }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      addScore(db(), "000000000000000000000000", T1, input, { source: "api" }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it("refuses the score that would exceed the per-trace cap", async () => {
    const { project } = await seed();
    for (let i = 0; i < SCORE_LIMITS.maxPerTrace; i++) {
      await addScore(
        db(),
        project.id,
        T1,
        { name: `s${i}`, dataType: "numeric", value: i },
        { source: "api" },
      );
    }
    await expect(
      addScore(
        db(),
        project.id,
        T1,
        { name: "one-more", dataType: "numeric", value: 1 },
        { source: "api" },
      ),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await scoreDocs(project.id)).toHaveLength(SCORE_LIMITS.maxPerTrace);
  }, 60_000);

  it("deleteScore promotes the previous score of that name, then clears the entry", async () => {
    const { project } = await seed();
    const bytesBefore = (await projectData(project.id)).estimatedBytes;
    const older = await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 0.2 },
      { source: "api" },
    );
    const newer = await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 0.9 },
      { source: "api" },
    );

    await deleteScore(db(), project.id, T1, newer.id);
    expect((await getTrace(db(), project.id, T1))!.scores.accuracy).toEqual({
      scoreId: older.id,
      dataType: "numeric",
      value: 0.2,
      evaluatorId: null,
    });

    await deleteScore(db(), project.id, T1, older.id);
    expect((await getTrace(db(), project.id, T1))!.scores).toEqual({});
    expect(await scoreDocs(project.id)).toEqual([]);
    expect((await projectData(project.id)).estimatedBytes).toBe(bytesBefore);

    await expect(deleteScore(db(), project.id, T1, older.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteScore(db(), project.id, T1, "not-an-id")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses to delete a score through another trace", async () => {
    const { project, apiKey } = await seed();
    expect((await postTrace(sampleTraceRequest({ id: T2 }), apiKey)).status).toBe(201);
    const score = await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 1 },
      { source: "api" },
    );
    await expect(deleteScore(db(), project.id, T2, score.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await scoreDocs(project.id)).toHaveLength(1);
  });

  it("deleting the trace removes its scores and gives the bytes back", async () => {
    const { project } = await seed();
    await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 1, comment: "x".repeat(300) },
      { source: "api" },
    );
    await deleteTrace(db(), project.id, T1);
    expect(await scoreDocs(project.id)).toEqual([]);
    const after = await projectData(project.id);
    expect(after.traceCount).toBe(0);
    expect(after.estimatedBytes).toBe(0);
  });

  it("deleting the project drains its scores and reports the count", async () => {
    const { project, apiKey } = await seed();
    expect((await postTrace(sampleTraceRequest({ id: T2 }), apiKey)).status).toBe(201);
    for (const traceId of [T1, T2]) {
      await addScore(
        db(),
        project.id,
        traceId,
        { name: "accuracy", dataType: "numeric", value: 1 },
        { source: "api" },
      );
    }
    const removed = await deleteProject(db(), project.id);
    expect(removed).toMatchObject({ traces: 2, scores: 2 });
    expect(await scoreDocs(project.id)).toEqual([]);
  });

  it("lists scores across traces newest first with a name filter and cursors", async () => {
    const { project, apiKey } = await seed();
    expect((await postTrace(sampleTraceRequest({ id: T2 }), apiKey)).status).toBe(201);
    const ids: string[] = [];
    for (const [traceId, name, value] of [
      [T1, "accuracy", 0.1],
      [T2, "accuracy", 0.2],
      [T1, "topic", "billing"],
      [T2, "accuracy", 0.3],
    ] as const) {
      const dataType = typeof value === "number" ? "numeric" : "categorical";
      ids.push(
        (await addScore(db(), project.id, traceId, { name, dataType, value }, { source: "api" }))
          .id,
      );
    }

    const all = await listScores(db(), project.id, {}, {});
    expect(all.scores.map((s) => s.id)).toEqual([...ids].reverse());
    expect(all.nextCursor).toBeNull();

    const page1 = await listScores(db(), project.id, { name: "accuracy" }, { limit: 2 });
    expect(page1.scores.map((s) => s.id)).toEqual([ids[3], ids[1]]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listScores(
      db(),
      project.id,
      { name: "accuracy" },
      { limit: 2, after: page1.nextCursor! },
    );
    expect(page2.scores.map((s) => s.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();

    const since = page1.scores[1].createdAt;
    const recent = await listScores(db(), project.id, { from: since }, {});
    expect(recent.scores.map((s) => s.id)).toEqual([ids[3], ids[2], ids[1]]);

    await expect(listScores(db(), project.id, {}, { after: "garbage" })).rejects.toMatchObject({
      status: 400,
    });
  });
});
