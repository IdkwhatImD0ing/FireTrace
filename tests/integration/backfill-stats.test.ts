import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { rebuildStats } from "../../scripts/backfill-stats";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { addScore } from "@/lib/firetrace/scores";
import { clearFirestore, createTestKey, createTestProject, db, postTrace } from "./helpers";

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const T2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const T3 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

function omit(doc: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
}

function stats(projectId: string) {
  return db().collection("projects").doc(projectId).collection("stats");
}

async function statsDocs(projectId: string) {
  const snap = await stats(projectId).get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, omit(d.data(), ["updatedAt"])]));
}

describe("backfill-stats against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("rebuilds exactly what ingest wrote, deleting stale days, and is idempotent", async () => {
    const project = await createTestProject("rebuild");
    const key = await createTestKey(project.id, "ingest");
    expect((await postTrace(sampleTraceRequest({ id: T1 }), key.plaintext)).status).toBe(201);
    const failed = sampleTraceRequest({ id: T2, name: "other-flow" });
    failed.trace.status = "error";
    expect((await postTrace(failed, key.plaintext)).status).toBe(201);
    const later = sampleTraceRequest({ id: T3, startedAt: "2026-09-03T08:00:00.000Z" });
    expect((await postTrace(later, key.plaintext)).status).toBe(201);
    await addScore(
      db(),
      project.id,
      T1,
      { name: "accuracy", dataType: "numeric", value: 0.8 },
      { source: "api" },
    );
    await addScore(
      db(),
      project.id,
      T2,
      { name: "helpful", dataType: "boolean", value: true },
      { source: "api" },
    );
    const live = await statsDocs(project.id);
    expect(Object.keys(live).sort()).toEqual(
      [...new Set(["2026-09-02", "2026-09-03", new Date().toISOString().slice(0, 10)])].sort(),
    );

    // Wipe the rollups and plant a stale day the way an old deployment might.
    for (const id of Object.keys(live)) await stats(project.id).doc(id).delete();
    await stats(project.id).doc("2020-01-01").set({ traces: 1 });

    const dry = await rebuildStats(db(), { projectId: project.id, apply: false });
    expect(dry).toEqual({
      traces: 3,
      scores: 2,
      days: Object.keys(live).length,
      written: 0,
      deleted: 0,
    });
    expect(Object.keys(await statsDocs(project.id))).toEqual(["2020-01-01"]);

    const applied = await rebuildStats(db(), { projectId: project.id, apply: true });
    expect(applied).toMatchObject({
      traces: 3,
      scores: 2,
      written: Object.keys(live).length,
      deleted: 1,
    });
    const rebuilt = await statsDocs(project.id);
    expect(Object.keys(rebuilt).sort()).toEqual(Object.keys(live).sort());
    for (const id of Object.keys(live)) {
      expect(omit(rebuilt[id], ["costUsd"])).toEqual(omit(live[id], ["costUsd"]));
      const liveCost = live[id].costUsd;
      if (typeof liveCost === "number") expect(rebuilt[id].costUsd).toBeCloseTo(liveCost, 9);
    }

    const again = await rebuildStats(db(), { projectId: project.id, apply: true });
    expect(again).toMatchObject({ written: Object.keys(live).length, deleted: 0 });
    const twice = await statsDocs(project.id);
    for (const id of Object.keys(live)) {
      expect(omit(twice[id], ["costUsd"])).toEqual(omit(rebuilt[id], ["costUsd"]));
    }
  });
});
