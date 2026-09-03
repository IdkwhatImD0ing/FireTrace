import "./env";
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey, rotateApiKey } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import type { TraceSummary } from "@/lib/firetrace/types";
import { TEST_PEPPER } from "./env";
import { callApi } from "./api-helpers";
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

type Page = { traces: TraceSummary[]; nextCursor: string | null; prevCursor: string | null };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

function traceAt(id: string, startedAt: string, status: "ok" | "error" = "ok") {
  const body = sampleTraceRequest();
  const shift = Date.parse(startedAt) - Date.parse(body.trace.startedAt);
  const move = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
  body.trace.id = id;
  body.trace.status = status;
  body.trace.startedAt = move(body.trace.startedAt);
  body.trace.endedAt = move(body.trace.endedAt);
  for (const span of body.trace.spans) {
    span.startedAt = move(span.startedAt);
    span.endedAt = move(span.endedAt);
    for (const event of span.events ?? []) event.timestamp = move(event.timestamp);
  }
  return body;
}

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const T2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const T3 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

async function seedThree(projectId: string) {
  const key = await createTestKey(projectId, "writer");
  expect((await postTrace(traceAt(T1, "2026-09-01T10:00:00.000Z"), key.plaintext)).status).toBe(
    201,
  );
  expect(
    (await postTrace(traceAt(T2, "2026-09-01T11:00:00.000Z", "error"), key.plaintext)).status,
  ).toBe(201);
  expect((await postTrace(traceAt(T3, "2026-09-01T12:00:00.000Z"), key.plaintext)).status).toBe(
    201,
  );
  return key;
}

describe("key-authenticated REST API against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("GET /api/v1/key describes the key without requiring a scope", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    const res = await callApi({ path: "/api/v1/key", apiKey: key.plaintext });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      keyId: key.key.id,
      projectId: project.id,
      scopes: ["traces:write", "traces:read"],
      expiresAt: null,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing, malformed, and unknown keys with 401 and a bearer challenge", async () => {
    const none = await callApi<ErrorBody>({ path: "/api/v1/key" });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("invalid_api_key");
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    const junk = await callApi<ErrorBody>({ path: "/api/v1/key", apiKey: "ft_live_nope" });
    expect(junk.status).toBe(401);
    const ghost = await callApi<ErrorBody>({
      path: "/api/v1/key",
      apiKey: `ft_live_${"0".repeat(16)}_${"0".repeat(64)}`,
    });
    expect(ghost.status).toBe(401);
  });

  it("lists traces newest first with filters and cursor pagination", async () => {
    const project = await createTestProject("alpha");
    const key = await seedThree(project.id);

    const all = await callApi<Page>({ path: "/api/v1/traces", apiKey: key.plaintext });
    expect(all.status).toBe(200);
    expect(all.body.traces.map((t) => t.id)).toEqual([T3, T2, T1]);
    expect(all.body.nextCursor).toBeNull();

    const first = await callApi<Page>({ path: "/api/v1/traces?limit=2", apiKey: key.plaintext });
    expect(first.body.traces.map((t) => t.id)).toEqual([T3, T2]);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await callApi<Page>({
      path: `/api/v1/traces?limit=2&after=${encodeURIComponent(first.body.nextCursor ?? "")}`,
      apiKey: key.plaintext,
    });
    expect(second.body.traces.map((t) => t.id)).toEqual([T1]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.prevCursor).not.toBeNull();

    const errors = await callApi<Page>({
      path: "/api/v1/traces?status=error",
      apiKey: key.plaintext,
    });
    expect(errors.body.traces.map((t) => t.id)).toEqual([T2]);

    const window = await callApi<Page>({
      path: "/api/v1/traces?from=2026-09-01T10:30:00Z&to=2026-09-01T11:30:00Z",
      apiKey: key.plaintext,
    });
    expect(window.body.traces.map((t) => t.id)).toEqual([T2]);

    const badCursor = await callApi<ErrorBody>({
      path: "/api/v1/traces?after=not-a-cursor",
      apiKey: key.plaintext,
    });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe("invalid_request");

    const badLimit = await callApi<ErrorBody>({
      path: "/api/v1/traces?limit=abc",
      apiKey: key.plaintext,
    });
    expect(badLimit.status).toBe(400);
  });

  it("returns one trace with its spans, and 404 for unknown or malformed ids", async () => {
    const project = await createTestProject("alpha");
    const key = await seedThree(project.id);

    const res = await callApi<{ trace: TraceSummary; spans: Array<{ id: string }> }>({
      path: `/api/v1/traces/${T2.toUpperCase()}`,
      apiKey: key.plaintext,
    });
    expect(res.status).toBe(200);
    expect(res.body.trace.id).toBe(T2);
    expect(res.body.trace.status).toBe("error");
    expect(res.body.spans).toHaveLength(5);

    const missing = await callApi<ErrorBody>({
      path: `/api/v1/traces/${"f".repeat(32)}`,
      apiKey: key.plaintext,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    const malformed = await callApi<ErrorBody>({
      path: "/api/v1/traces/not-hex",
      apiKey: key.plaintext,
    });
    expect(malformed.status).toBe(404);
  });

  it("never leaks traces across projects", async () => {
    const alpha = await createTestProject("alpha");
    const beta = await createTestProject("beta");
    await seedThree(alpha.id);
    const betaKey = await createTestKey(beta.id);

    const list = await callApi<Page>({ path: "/api/v1/traces", apiKey: betaKey.plaintext });
    expect(list.body.traces).toEqual([]);
    const one = await callApi<ErrorBody>({
      path: `/api/v1/traces/${T1}`,
      apiKey: betaKey.plaintext,
    });
    expect(one.status).toBe(404);
  });

  it("enforces scopes: write-only keys cannot read, read-only keys cannot write, delete needs traces:delete", async () => {
    const project = await createTestProject("alpha");
    const writer = await createApiKey(db(), {
      projectId: project.id,
      label: "writer",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:write"],
    });
    const reader = await createApiKey(db(), {
      projectId: project.id,
      label: "reader",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:read"],
    });
    const body = sampleTraceRequest();
    expect((await postTrace(body, writer.plaintext)).status).toBe(201);

    const denied = await callApi<ErrorBody>({ path: "/api/v1/traces", apiKey: writer.plaintext });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("insufficient_scope");
    expect(denied.body.error.message).toContain("traces:read");

    const readOnlyPost = await postTrace(body, reader.plaintext);
    expect(readOnlyPost.status).toBe(403);
    expect(readOnlyPost.body.error?.code).toBe("insufficient_scope");

    const readOnlyDelete = await callApi<ErrorBody>({
      method: "DELETE",
      path: `/api/v1/traces/${body.trace.id}`,
      apiKey: reader.plaintext,
    });
    expect(readOnlyDelete.status).toBe(403);
    expect(await traceData(project.id, body.trace.id)).not.toBeNull();

    const listed = await callApi<Page>({ path: "/api/v1/traces", apiKey: reader.plaintext });
    expect(listed.status).toBe(200);
    expect(listed.body.traces).toHaveLength(1);
  });

  it("DELETE removes the trace and its spans and fixes counters; a second delete is 404", async () => {
    const project = await createTestProject("alpha");
    await seedThree(project.id);
    const deleter = await createApiKey(db(), {
      projectId: project.id,
      label: "deleter",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:read", "traces:delete"],
    });

    const res = await callApi({
      method: "DELETE",
      path: `/api/v1/traces/${T2}`,
      apiKey: deleter.plaintext,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, traceId: T2 });
    expect(await traceData(project.id, T2)).toBeNull();
    expect(await spanDocs(project.id, T2)).toHaveLength(0);
    const counters = await projectData(project.id);
    expect(counters.traceCount).toBe(2);
    expect(counters.spanCount).toBe(10);

    const again = await callApi<ErrorBody>({
      method: "DELETE",
      path: `/api/v1/traces/${T2}`,
      apiKey: deleter.plaintext,
    });
    expect(again.status).toBe(404);
  });

  it("GET /api/v1/project returns counters, storage level, and the key's scopes", async () => {
    const project = await createTestProject("alpha");
    const key = await seedThree(project.id);
    const res = await callApi<{
      id: string;
      traceCount: number;
      spanCount: number;
      storage: { limitBytes: number; level: string };
      keyScopes: string[];
    }>({ path: "/api/v1/project", apiKey: key.plaintext });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(project.id);
    expect(res.body.traceCount).toBe(3);
    expect(res.body.spanCount).toBe(15);
    expect(res.body.storage.level).toBe("ok");
    expect(res.body.keyScopes).toEqual(["traces:write", "traces:read"]);
  });

  it("rejects expired keys with 401 while unexpired ones work", async () => {
    const project = await createTestProject("alpha");
    const expired = await createApiKey(db(), {
      projectId: project.id,
      label: "expired",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      expiresAt: new Date(Date.now() - 1000),
    });
    const live = await createApiKey(db(), {
      projectId: project.id,
      label: "live",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(expired.key.expiresAt).not.toBeNull();
    const dead = await callApi<ErrorBody>({ path: "/api/v1/key", apiKey: expired.plaintext });
    expect(dead.status).toBe(401);
    const ok = await callApi<{ expiresAt: string }>({
      path: "/api/v1/key",
      apiKey: live.plaintext,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.expiresAt).toBe(live.key.expiresAt);
  });

  it("treats keys created before scopes existed as write-only and preserves scopes/expiry across rotation", async () => {
    const project = await createTestProject("alpha");
    const legacy = await createTestKey(project.id, "legacy");
    await db()
      .collection("apiKeys")
      .doc(legacy.key.id)
      .update({ scopes: null, expiresAt: null, lastUsedAt: null });
    const info = await callApi<{ scopes: string[] }>({
      path: "/api/v1/key",
      apiKey: legacy.plaintext,
    });
    expect(info.body.scopes).toEqual(["traces:write"]);
    expect((await postTrace(sampleTraceRequest(), legacy.plaintext)).status).toBe(201);
    expect(
      (await callApi<ErrorBody>({ path: "/api/v1/traces", apiKey: legacy.plaintext })).status,
    ).toBe(403);

    const scoped = await createApiKey(db(), {
      projectId: project.id,
      label: "scoped",
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
      scopes: ["traces:read", "traces:delete"],
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const rotated = await rotateApiKey(db(), {
      projectId: project.id,
      keyId: scoped.key.id,
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
    });
    expect(rotated.key.scopes).toEqual(["traces:read", "traces:delete"]);
    expect(rotated.key.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    const old = await callApi<ErrorBody>({ path: "/api/v1/key", apiKey: scoped.plaintext });
    expect(old.status).toBe(401);
  });

  it("records lastUsedAt after a successful call", async () => {
    const project = await createTestProject("alpha");
    const key = await createTestKey(project.id);
    expect(key.key.lastUsedAt).toBeNull();
    await callApi({ path: "/api/v1/key", apiKey: key.plaintext });
    let touched: unknown = null;
    for (let i = 0; i < 20 && !touched; i++) {
      await new Promise((r) => setTimeout(r, 50));
      touched = (await db().collection("apiKeys").doc(key.key.id).get()).get("lastUsedAt");
    }
    expect(touched).toBeInstanceOf(Timestamp);
  });
});
