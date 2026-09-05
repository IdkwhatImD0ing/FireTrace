import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import type { Score, ScorePage, TraceDetail, TracePage } from "@/lib/firetrace/types";
import { callApi } from "./api-helpers";
import { TEST_PEPPER } from "./env";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  OWNER_UID,
  postTrace,
} from "./helpers";

type ErrorBody = { error: { code: string; message: string; requestId: string } };
type AddResult = { ok: boolean; score: Score; requestId: string } & ErrorBody;

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const MISSING = "0000000000000000000000000000dead";

function keyWith(
  projectId: string,
  scopes: Array<"traces:write" | "traces:read" | "traces:delete">,
) {
  return createApiKey(db(), {
    projectId,
    label: scopes.join("+"),
    createdByUid: OWNER_UID,
    pepper: TEST_PEPPER,
    scopes,
  });
}

async function seed() {
  const project = await createTestProject("alpha");
  const key = await createTestKey(project.id, "scorer");
  expect((await postTrace(sampleTraceRequest({ id: T1 }), key.plaintext)).status).toBe(201);
  return { project, apiKey: key.plaintext };
}

function addScore(traceId: string, apiKey: string | null, body: unknown) {
  return callApi<AddResult>({
    method: "POST",
    path: `/api/v1/traces/${traceId}/scores`,
    apiKey,
    body,
  });
}

describe("score routes against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("adds a score and shows it on the trace, its score list, the project list and the trace list", async () => {
    const { apiKey } = await seed();
    const res = await addScore(T1.toUpperCase(), apiKey, {
      name: "accuracy",
      dataType: "numeric",
      value: 0.8,
      comment: "close enough",
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.score).toMatchObject({
      traceId: T1,
      name: "accuracy",
      dataType: "numeric",
      value: 0.8,
      comment: "close enough",
      source: "api",
    });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{16}$/);
    const scoreId = res.body.score.id;

    const detail = await callApi<{ trace: TraceDetail; scores: Score[] }>({
      path: `/api/v1/traces/${T1}`,
      apiKey,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.trace.scores).toEqual({
      accuracy: { scoreId, dataType: "numeric", value: 0.8, evaluatorId: null },
    });
    expect(detail.body.scores.map((s) => s.id)).toEqual([scoreId]);

    const perTrace = await callApi<{ traceId: string; scores: Score[] }>({
      path: `/api/v1/traces/${T1}/scores`,
      apiKey,
    });
    expect(perTrace.status).toBe(200);
    expect(perTrace.body).toMatchObject({ traceId: T1 });
    expect(perTrace.body.scores.map((s) => s.id)).toEqual([scoreId]);

    const acrossProject = await callApi<ScorePage>({
      path: "/api/v1/scores?name=accuracy",
      apiKey,
    });
    expect(acrossProject.status).toBe(200);
    expect(acrossProject.body.scores.map((s) => s.id)).toEqual([scoreId]);
    expect(acrossProject.body.nextCursor).toBeNull();

    const list = await callApi<TracePage>({ path: "/api/v1/traces", apiKey });
    expect(list.body.traces[0].scores.accuracy?.value).toBe(0.8);
  });

  it("validates the body and names the field", async () => {
    const { apiKey } = await seed();
    const wrongType = await addScore(T1, apiKey, {
      name: "accuracy",
      dataType: "numeric",
      value: "high",
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe("invalid_request");
    expect(wrongType.body.error.message).toContain("value");

    const badName = await addScore(T1, apiKey, {
      name: "has.dot",
      dataType: "boolean",
      value: true,
    });
    expect(badName.status).toBe(400);
    expect(badName.body.error.message).toContain("name");

    const notJson = await addScore(T1, apiKey, "{not json");
    expect(notJson.status).toBe(400);
    expect(notJson.body.error.code).toBe("invalid_json");

    const missing = await addScore(MISSING, apiKey, {
      name: "a",
      dataType: "boolean",
      value: true,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("enforces scopes on every route", async () => {
    const { project, apiKey } = await seed();
    const readOnly = await keyWith(project.id, ["traces:read"]);
    const writeOnly = await keyWith(project.id, ["traces:write"]);
    const deleter = await keyWith(project.id, ["traces:delete"]);
    const body = { name: "helpful", dataType: "boolean", value: true };

    const added = await addScore(T1, apiKey, body);
    expect(added.status).toBe(201);
    const scoreId = added.body.score.id;

    expect((await addScore(T1, readOnly.plaintext, body)).status).toBe(403);
    expect((await addScore(T1, readOnly.plaintext, body)).body.error.code).toBe(
      "insufficient_scope",
    );
    expect((await addScore(T1, null, body)).status).toBe(401);
    expect(
      (await callApi({ path: `/api/v1/traces/${T1}/scores`, apiKey: writeOnly.plaintext })).status,
    ).toBe(403);
    expect((await callApi({ path: "/api/v1/scores", apiKey: writeOnly.plaintext })).status).toBe(
      403,
    );

    const refused = await callApi<ErrorBody>({
      method: "DELETE",
      path: `/api/v1/traces/${T1}/scores/${scoreId}`,
      apiKey,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("insufficient_scope");

    const deleted = await callApi<{ ok: boolean; traceId: string; scoreId: string }>({
      method: "DELETE",
      path: `/api/v1/traces/${T1}/scores/${scoreId}`,
      apiKey: deleter.plaintext,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ ok: true, traceId: T1, scoreId });

    const again = await callApi<ErrorBody>({
      method: "DELETE",
      path: `/api/v1/traces/${T1}/scores/${scoreId}`,
      apiKey: deleter.plaintext,
    });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_found");

    const detail = await callApi<{ trace: TraceDetail; scores: Score[] }>({
      path: `/api/v1/traces/${T1}`,
      apiKey,
    });
    expect(detail.body.trace.scores).toEqual({});
    expect(detail.body.scores).toEqual([]);
  });

  it("pages the project-wide list with cursors and rejects bad parameters", async () => {
    const { apiKey } = await seed();
    const ids: string[] = [];
    for (const value of [0.1, 0.2, 0.3]) {
      const res = await addScore(T1, apiKey, { name: "accuracy", dataType: "numeric", value });
      ids.push(res.body.score.id);
    }
    const page1 = await callApi<ScorePage>({ path: "/api/v1/scores?limit=2", apiKey });
    expect(page1.status).toBe(200);
    expect(page1.body.scores.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await callApi<ScorePage>({
      path: `/api/v1/scores?limit=2&after=${encodeURIComponent(page1.body.nextCursor!)}`,
      apiKey,
    });
    expect(page2.body.scores.map((s) => s.id)).toEqual([ids[0]]);
    expect(page2.body.nextCursor).toBeNull();

    const garbage = await callApi<ErrorBody>({ path: "/api/v1/scores?after=garbage", apiKey });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe("invalid_request");
    expect((await callApi({ path: "/api/v1/scores?limit=abc", apiKey })).status).toBe(400);
  });
});
