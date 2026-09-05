import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProject, deleteTrace } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { addScore, deleteScore } from "@/lib/firetrace/scores";
import { encodeKey, latencyBucket, OTHER_KEY } from "@/lib/firetrace/stats-rollup";
import { clearFirestore, createTestKey, createTestProject, db, postTrace } from "./helpers";

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const T2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const DAY = "2026-09-02"; // sampleTraceRequest() starts at 2026-09-02T19:01:02.120Z
const MODEL = encodeKey("example-model");
const ANSWER = encodeKey("answer-question");
const OTHER = encodeKey("other-flow");

async function day(projectId: string, id = DAY) {
  const snap = await db().collection("projects").doc(projectId).collection("stats").doc(id).get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

async function seed() {
  const project = await createTestProject("stats");
  const key = await createTestKey(project.id, "ingest");
  expect((await postTrace(sampleTraceRequest({ id: T1 }), key.plaintext)).status).toBe(201);
  const failed = sampleTraceRequest({ id: T2, name: "other-flow" });
  failed.trace.status = "error";
  failed.trace.model = undefined;
  expect((await postTrace(failed, key.plaintext)).status).toBe(201);
  return { project, apiKey: key.plaintext };
}

describe("per-day stats rollups against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("ingest increments the day document, duplicates do not", async () => {
    const { project, apiKey } = await seed();
    const doc = (await day(project.id))!;
    expect(doc).toMatchObject({
      traces: 2,
      errors: 1,
      spans: 10,
      inputTokens: 824,
      outputTokens: 192,
      totalTokens: 1016,
      durationMsSum: 2692 * 2,
    });
    expect(doc.costUsd).toBeCloseTo(0.0024, 6);
    expect(doc.hours["19"]).toMatchObject({ traces: 2, errors: 1, totalTokens: 1016 });
    expect(doc.byModel[MODEL]).toMatchObject({ traces: 1, inputTokens: 412, outputTokens: 96 });
    expect(doc.byModel[OTHER_KEY]).toMatchObject({ traces: 1 });
    expect(doc.byName[ANSWER]).toMatchObject({ traces: 1, durationMsSum: 2692 });
    expect(doc.byName[ANSWER].hist[String(latencyBucket(2692))]).toBe(1);
    expect(doc.byName[OTHER]).toMatchObject({ traces: 1, errors: 1 });
    expect(doc.updatedAt).toBeTruthy();

    const resend = await postTrace(sampleTraceRequest({ id: T1 }), apiKey);
    expect(resend.status).toBe(200);
    expect((await day(project.id))!.traces).toBe(2);
  });

  it("scores roll up by their own day and come back out when deleted", async () => {
    const { project } = await seed();
    const today = new Date().toISOString().slice(0, 10);
    const numeric = await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 0.8 },
      { source: "api" },
    );
    await addScore(
      db(),
      project.id,
      T1,
      { name: "helpful", dataType: "boolean", value: true },
      { source: "api" },
    );
    await addScore(
      db(),
      project.id,
      T2,
      { name: "helpful", dataType: "boolean", value: false },
      { source: "api" },
    );
    let doc = (await day(project.id, today))!;
    expect(doc.scores[encodeKey("accuracy")]).toMatchObject({ count: 1, sum: 0.8 });
    expect(doc.scores[encodeKey("helpful")]).toMatchObject({
      count: 2,
      values: { [encodeKey("true")]: 1, [encodeKey("false")]: 1 },
    });

    await deleteScore(db(), project.id, T1, numeric.id);
    doc = (await day(project.id, today))!;
    expect(doc.scores[encodeKey("accuracy")]).toMatchObject({ count: 0 });
    expect(doc.scores[encodeKey("accuracy")].sum).toBeCloseTo(0, 6);

    // Deleting the trace cascades to its remaining score and to the trace's own day.
    await deleteTrace(db(), project.id, T1);
    doc = (await day(project.id, today))!;
    expect(doc.scores[encodeKey("helpful")]).toMatchObject({
      count: 1,
      values: { [encodeKey("true")]: 0, [encodeKey("false")]: 1 },
    });
  });

  it("deleting a trace subtracts its contribution; deleting the project removes the docs", async () => {
    const { project } = await seed();
    await deleteTrace(db(), project.id, T2);
    const doc = (await day(project.id))!;
    expect(doc).toMatchObject({ traces: 1, errors: 0, spans: 5, totalTokens: 508 });
    expect(doc.hours["19"]).toMatchObject({ traces: 1, errors: 0 });
    expect(doc.byName[OTHER]).toMatchObject({ traces: 0, errors: 0 });
    expect(doc.byModel[OTHER_KEY]).toMatchObject({ traces: 0 });
    expect(doc.byName[ANSWER]).toMatchObject({ traces: 1 });

    await deleteProject(db(), project.id);
    expect(await day(project.id)).toBeNull();
  });
});
