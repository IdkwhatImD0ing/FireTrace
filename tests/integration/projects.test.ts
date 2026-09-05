import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/firetrace/errors";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import {
  deleteProject,
  deleteTrace,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import {
  apiKeyIdsForProject,
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  OWNER_UID,
  postTrace,
  projectData,
  spanDocs,
  spanPathsUnderProject,
  traceData,
  traceIds,
} from "./helpers";
import { TEST_PEPPER } from "./env";

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const TRACE_C = "c".repeat(32);

function bytesOf(id: string): number {
  const result = normalizeIngestBody(sampleTraceRequest({ id }));
  if (!result.ok) throw new Error(result.error.message);
  return result.value.estimatedBytes;
}

describe("trace and project deletion against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("deleteTrace removes the trace and every span descendant and fixes the counters", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    expect((await postTrace(sampleTraceRequest({ id: TRACE_A }), key.plaintext)).status).toBe(201);
    expect((await postTrace(sampleTraceRequest({ id: TRACE_B }), key.plaintext)).status).toBe(201);
    expect((await projectData(project.id)).traceCount).toBe(2);
    expect((await projectData(project.id)).spanCount).toBe(10);

    await deleteTrace(db(), project.id, TRACE_A);

    expect(await traceData(project.id, TRACE_A)).toBeNull();
    expect(await spanDocs(project.id, TRACE_A)).toHaveLength(0);
    expect(await traceIds(project.id)).toEqual([TRACE_B]);
    expect(await spanDocs(project.id, TRACE_B)).toHaveLength(5);
    expect(await spanPathsUnderProject(project.id)).toHaveLength(5);

    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(1);
    expect(counters.spanCount).toBe(5);
    expect(counters.estimatedBytes).toBe(bytesOf(TRACE_B));

    await expect(deleteTrace(db(), project.id, TRACE_A)).rejects.toMatchObject({ status: 404 });
    await expect(deleteTrace(db(), project.id, TRACE_A)).rejects.toBeInstanceOf(ApiError);
  });

  it("deleteTrace never reaches into another project", async () => {
    const alpha = await createTestProject("alpha");
    const beta = await createTestProject("beta");
    const alphaKey = await createTestKey(alpha.id);
    const betaKey = await createTestKey(beta.id);
    expect((await postTrace(sampleTraceRequest({ id: TRACE_A }), alphaKey.plaintext)).status).toBe(
      201,
    );
    expect((await postTrace(sampleTraceRequest({ id: TRACE_A }), betaKey.plaintext)).status).toBe(
      201,
    );

    await deleteTrace(db(), alpha.id, TRACE_A);

    expect(await traceIds(alpha.id)).toEqual([]);
    expect(await traceIds(beta.id)).toEqual([TRACE_A]);
    expect(await spanDocs(beta.id, TRACE_A)).toHaveLength(5);
    expect((await projectData(beta.id)).traceCount).toBe(1);
    expect((await projectData(beta.id)).spanCount).toBe(5);
  });

  it("deleteProject removes traces, spans and API keys and leaves other projects untouched", async () => {
    const doomed = await createTestProject("doomed");
    const survivor = await createTestProject("survivor");
    const doomedKey = await createTestKey(doomed.id, "active");
    const doomedRevoked = await createTestKey(doomed.id, "old");
    await revokeApiKey(db(), doomed.id, doomedRevoked.key.id);
    const survivorKey = await createTestKey(survivor.id, "keep");

    for (const id of [TRACE_A, TRACE_B, TRACE_C]) {
      expect((await postTrace(sampleTraceRequest({ id }), doomedKey.plaintext)).status).toBe(201);
    }
    expect(
      (await postTrace(sampleTraceRequest({ id: TRACE_A }), survivorKey.plaintext)).status,
    ).toBe(201);
    expect(await spanPathsUnderProject(doomed.id)).toHaveLength(15);

    const removed = await deleteProject(db(), doomed.id);
    expect(removed).toEqual({
      traces: 3,
      spans: 15,
      apiKeys: 2,
      scores: 0,
      evaluators: 0,
      evalRuns: 0,
    });

    expect((await db().collection("projects").doc(doomed.id).get()).exists).toBe(false);
    expect(await traceIds(doomed.id)).toEqual([]);
    expect(await spanPathsUnderProject(doomed.id)).toHaveLength(0);
    expect(await apiKeyIdsForProject(doomed.id)).toEqual([]);
    expect((await db().collection("apiKeys").doc(doomedKey.key.id).get()).exists).toBe(false);
    expect((await db().collection("apiKeys").doc(doomedRevoked.key.id).get()).exists).toBe(false);

    // The deleted project's key is dead even though its plaintext is still known.
    const afterDelete = await postTrace(
      sampleTraceRequest({ id: "d".repeat(32) }),
      doomedKey.plaintext,
    );
    expect(afterDelete.status).toBe(401);

    expect(await traceIds(survivor.id)).toEqual([TRACE_A]);
    expect(await spanPathsUnderProject(survivor.id)).toHaveLength(5);
    expect(await apiKeyIdsForProject(survivor.id)).toEqual([survivorKey.key.id]);
    expect((await projectData(survivor.id)).traceCount).toBe(1);

    await expect(deleteProject(db(), doomed.id)).rejects.toMatchObject({ status: 404 });
  });

  it("rotateApiKey revokes the old key and the new key ingests immediately", async () => {
    const project = await createTestProject("alpha");
    const original = await createTestKey(project.id, "prod");

    const rotated = await rotateApiKey(db(), {
      projectId: project.id,
      keyId: original.key.id,
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
    });
    expect(rotated.key.label).toBe("prod");
    expect(rotated.key.id).not.toBe(original.key.id);
    expect(rotated.plaintext).toMatch(/^ft_live_[0-9a-f]{16}_[0-9a-f]{64}$/);

    const keys = await listApiKeys(db(), project.id);
    expect(keys.find((k) => k.id === original.key.id)?.revokedAt).not.toBeNull();
    expect(keys.find((k) => k.id === rotated.key.id)?.revokedAt).toBeNull();

    expect((await postTrace(sampleTraceRequest(), original.plaintext)).status).toBe(401);
    expect((await postTrace(sampleTraceRequest(), rotated.plaintext)).status).toBe(201);

    // A key from another project cannot be revoked or rotated through this project.
    const other = await createTestProject("other");
    await expect(revokeApiKey(db(), other.id, rotated.key.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      rotateApiKey(db(), {
        projectId: other.id,
        keyId: rotated.key.id,
        createdByUid: OWNER_UID,
        pepper: TEST_PEPPER,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
