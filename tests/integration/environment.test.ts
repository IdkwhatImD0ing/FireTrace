import "./env";
import { FieldValue } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { assignEnvironment } from "../../scripts/backfill-environment";
import {
  createApiKey,
  deleteTrace,
  revokeApiKey,
  rotateApiKey,
  setApiKeyEnvironment,
} from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { addScore } from "@/lib/firetrace/scores";
import { getProjectStats } from "@/lib/firetrace/stats";
import type { KeyScope } from "@/lib/firetrace/scopes";
import type { Score, TraceSummary } from "@/lib/firetrace/types";
import { TEST_PEPPER } from "./env";
import { callApi, mcpTool } from "./api-helpers";
import { clearFirestore, createTestProject, db, OWNER_UID, postTrace, traceData } from "./helpers";

type Page = { traces: TraceSummary[]; nextCursor: string | null };
type ScorePage = { scores: Score[]; nextCursor: string | null };
type ErrorBody = { error: { code: string; message: string; requestId: string } };
type KeyBody = { keyId: string; environment: string | null };

const PROD = "a1".repeat(16);
const PREV = "b2".repeat(16);
const NONE = "c3".repeat(16);
const DAY = "2026-09-02"; // sampleTraceRequest() starts at 2026-09-02T19:01:02.120Z
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function key(projectId: string, label: string, environment: string | null, scopes?: KeyScope[]) {
  return createApiKey(db(), {
    projectId,
    label,
    createdByUid: OWNER_UID,
    pepper: TEST_PEPPER,
    environment,
    scopes,
  });
}

async function envDay(projectId: string, id: string) {
  const snap = await db()
    .collection("projects")
    .doc(projectId)
    .collection("statsByEnv")
    .doc(id)
    .get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

async function envDayIds(projectId: string) {
  const snap = await db().collection("projects").doc(projectId).collection("statsByEnv").get();
  return snap.docs.map((d) => d.id).sort();
}

const ids = (page: Page) => page.traces.map((t) => t.id);
const list = (apiKey: string, query: string) =>
  callApi<Page>({ path: `/api/v1/traces${query}`, apiKey });

/** Three keys, three traces: one per environment plus one from a key without an environment. */
async function seed() {
  const project = await createTestProject("envs");
  const production = await key(project.id, "production", "production");
  const preview = await key(project.id, "preview", "preview");
  const legacy = await key(project.id, "legacy", null);
  expect((await postTrace(sampleTraceRequest({ id: PROD }), production.plaintext)).status).toBe(
    201,
  );
  const failed = sampleTraceRequest({ id: PREV });
  failed.trace.status = "error";
  failed.trace.costUsd = 0.5;
  expect((await postTrace(failed, preview.plaintext)).status).toBe(201);
  expect((await postTrace(sampleTraceRequest({ id: NONE }), legacy.plaintext)).status).toBe(201);
  return { project, production, preview, legacy };
}

describe("environments against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("keys carry an environment that GET /api/v1/key reports, rotation keeps and editing changes", async () => {
    const project = await createTestProject("keys");
    const production = await key(project.id, "prod", "production");
    const legacy = await key(project.id, "legacy", null);
    expect(production.key.environment).toBe("production");
    expect(legacy.key.environment).toBeNull();

    const prodInfo = await callApi<KeyBody>({ path: "/api/v1/key", apiKey: production.plaintext });
    expect(prodInfo.status).toBe(200);
    expect(prodInfo.body.environment).toBe("production");
    const legacyInfo = await callApi<KeyBody>({ path: "/api/v1/key", apiKey: legacy.plaintext });
    expect(legacyInfo.body.environment).toBeNull();

    const rotated = await rotateApiKey(db(), {
      projectId: project.id,
      keyId: production.key.id,
      createdByUid: OWNER_UID,
      pepper: TEST_PEPPER,
    });
    expect(rotated.key.environment).toBe("production");

    const edited = await setApiKeyEnvironment(db(), project.id, legacy.key.id, "staging");
    expect(edited.environment).toBe("staging");
    const after = await callApi<KeyBody>({ path: "/api/v1/key", apiKey: legacy.plaintext });
    expect(after.body.environment).toBe("staging");
    await setApiKeyEnvironment(db(), project.id, legacy.key.id, null);
    expect(
      (await callApi<KeyBody>({ path: "/api/v1/key", apiKey: legacy.plaintext })).body.environment,
    ).toBeNull();
  });

  it("ingest stamps the key's environment and key id; the body cannot carry one", async () => {
    const { project, production, preview, legacy } = await seed();
    const prod = await traceData(project.id, PROD);
    expect(prod?.environment).toBe("production");
    expect(prod?.keyId).toBe(production.key.id);
    const none = await traceData(project.id, NONE);
    expect(none).not.toBeNull();
    expect("environment" in (none ?? {})).toBe(true);
    expect(none?.environment).toBeNull();
    expect(none?.keyId).toBe(legacy.key.id);

    const body = sampleTraceRequest({ id: "d4".repeat(16) });
    (body.trace as Record<string, unknown>).environment = "production";
    const rejected = await postTrace(body, production.plaintext);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe("invalid_trace");
    expect(rejected.body.error?.message).toContain("environment");
    expect(await traceData(project.id, "d4".repeat(16))).toBeNull();

    // A resend through another key is the same trace: duplicate, environment untouched.
    const resend = await postTrace(sampleTraceRequest({ id: PROD }), preview.plaintext);
    expect(resend.status).toBe(200);
    expect(resend.body.duplicate).toBe(true);
    expect((await traceData(project.id, PROD))?.environment).toBe("production");

    const detail = await callApi<{ trace: TraceSummary }>({
      path: `/api/v1/traces/${PROD}`,
      apiKey: production.plaintext,
    });
    expect(detail.body.trace.environment).toBe("production");
  });

  it("filters the list by environment, composing with every sort and filter, and returns it on each trace", async () => {
    const { legacy } = await seed();
    const reader = legacy.plaintext;
    expect(ids((await list(reader, "")).body)).toEqual([NONE, PREV, PROD]);
    expect((await list(reader, "")).body.traces.map((t) => t.environment)).toEqual([
      null,
      "preview",
      "production",
    ]);
    expect(ids((await list(reader, "?environment=production")).body)).toEqual([PROD]);
    expect(ids((await list(reader, "?environment=Preview")).body)).toEqual([PREV]);
    expect(ids((await list(reader, "?environment=unassigned")).body)).toEqual([NONE]);
    expect(ids((await list(reader, "?environment=production&status=error")).body)).toEqual([]);
    expect(
      ids((await list(reader, "?environment=preview&status=error&sort=costliest")).body),
    ).toEqual([PREV]);
    expect(ids((await list(reader, "?environment=production&sort=slowest")).body)).toEqual([PROD]);
    expect(
      ids((await list(reader, "?environment=unassigned&from=2026-09-02T00:00:00Z")).body),
    ).toEqual([NONE]);
    const nobody = await list(reader, "?environment=qa");
    expect(nobody.status).toBe(200);
    expect(nobody.body.traces).toEqual([]);
  });

  it("rejects unknown query parameters and values with 400 instead of returning unfiltered data", async () => {
    const { legacy } = await seed();
    const reader = legacy.plaintext;
    const reject = async (path: string) => {
      const res = await callApi<ErrorBody>({ path, apiKey: reader });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(res.body.error.requestId).toMatch(/^[0-9a-f]{16}$/);
      return res.body.error.message;
    };
    expect(await reject("/api/v1/traces?env=production")).toContain('"env"');
    expect(await reject("/api/v1/traces?env=production")).toContain("environment");
    expect(await reject("/api/v1/traces?environment=production&Status=error")).toContain(
      '"Status"',
    );
    expect(await reject("/api/v1/traces?environment=prod%20env")).toContain("prod env");
    expect(await reject("/api/v1/traces?status=failed")).toContain('"failed"');
    expect(await reject("/api/v1/traces?sort=fastest")).toContain('"fastest"');
    expect(await reject("/api/v1/traces?from=yesterday")).toContain('"yesterday"');
    expect(await reject("/api/v1/scores?foo=1")).toContain('"foo"');
    expect(await reject("/api/v1/scores?name=bad.name")).toContain("bad.name");
    expect(await reject("/api/v1/scores?environment=Prod!")).toContain("Prod!");

    const fine = await list(reader, "?status=error&limit=5&environment=preview");
    expect(fine.status).toBe(200);
    expect(ids(fine.body)).toEqual([PREV]);
  });

  it("scores follow their trace's environment through the parent trace", async () => {
    const { project, legacy } = await seed();
    const add = (traceId: string, name: string, value: number | boolean) =>
      addScore(
        db(),
        project.id,
        traceId,
        { name, dataType: typeof value === "number" ? "numeric" : "boolean", value },
        { source: "api" },
      );
    const prodHelpful = await add(PROD, "helpful", true);
    const prodAccuracy = await add(PROD, "accuracy", 0.9);
    await add(PREV, "helpful", false);
    const noneAccuracy = await add(NONE, "accuracy", 0.5);
    const scores = (query: string) =>
      callApi<ScorePage>({ path: `/api/v1/scores${query}`, apiKey: legacy.plaintext });

    expect((await scores("")).body.scores).toHaveLength(4);
    const prod = await scores("?environment=production");
    expect(prod.status).toBe(200);
    expect(prod.body.scores.map((s) => s.id).sort()).toEqual(
      [prodHelpful.id, prodAccuracy.id].sort(),
    );
    expect(prod.body.scores.every((s) => s.traceId === PROD)).toBe(true);
    expect((await scores("?environment=unassigned")).body.scores.map((s) => s.id)).toEqual([
      noneAccuracy.id,
    ]);
    expect((await scores("?environment=preview&name=helpful")).body.scores).toHaveLength(1);
    expect((await scores("?environment=qa")).body.scores).toEqual([]);

    // Pagination scans past non-matching scores and continues from the last one examined.
    const first = await scores("?environment=production&limit=1");
    expect(first.body.scores).toHaveLength(1);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await scores(
      `?environment=production&limit=1&after=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(second.body.scores).toHaveLength(1);
    expect(second.body.scores[0].id).not.toBe(first.body.scores[0].id);
    expect([first.body.scores[0].id, second.body.scores[0].id].sort()).toEqual(
      [prodHelpful.id, prodAccuracy.id].sort(),
    );
    // The oldest production score is the oldest score overall, so the scan is exhausted.
    expect(second.body.nextCursor).toBeNull();

    const viaMcp = await mcpTool(legacy.plaintext, "list_scores", { environment: "unassigned" });
    const structured = viaMcp.result?.structuredContent as { scores: Array<{ id: string }> };
    expect(structured.scores.map((s) => s.id)).toEqual([noneAccuracy.id]);
  });

  it("keeps per-environment rollups that the dashboard reads for the selected environment", async () => {
    const { project, legacy } = await seed();
    expect(await envDayIds(project.id)).toEqual([
      `_unassigned:${DAY}`,
      `preview:${DAY}`,
      `production:${DAY}`,
    ]);
    // Zero increments are never written, so a clean day has no `errors` field.
    const productionDay = await envDay(project.id, `production:${DAY}`);
    expect(productionDay).toMatchObject({ traces: 1, spans: 5 });
    expect(productionDay?.errors ?? 0).toBe(0);
    expect(await envDay(project.id, `preview:${DAY}`)).toMatchObject({ traces: 1, errors: 1 });
    expect(await envDay(project.id, `_unassigned:${DAY}`)).toMatchObject({ traces: 1 });

    const all = await getProjectStats(db(), project.id, "7d", undefined, NOW);
    expect(all.totals).toMatchObject({ traces: 3, errors: 1 });
    const production = await getProjectStats(db(), project.id, "7d", "production", NOW);
    expect(production.totals).toMatchObject({ traces: 1, errors: 0 });
    expect(production.byName[0]?.traces).toBe(1);
    const preview = await getProjectStats(db(), project.id, "7d", "preview", NOW);
    expect(preview.totals).toMatchObject({ traces: 1, errors: 1, errorRate: 1 });
    expect((await getProjectStats(db(), project.id, "7d", "unassigned", NOW)).totals.traces).toBe(
      1,
    );
    expect((await getProjectStats(db(), project.id, "7d", "qa", NOW)).days).toBe(0);

    // Scores roll up under the trace's environment; deleting the trace gives everything back.
    await addScore(
      db(),
      project.id,
      PROD,
      { name: "helpful", dataType: "boolean", value: true },
      { source: "api" },
    );
    const today = new Date().toISOString().slice(0, 10);
    expect((await envDay(project.id, `production:${today}`))?.scores).toBeTruthy();
    expect((await envDay(project.id, `preview:${today}`))?.scores).toBeUndefined();
    await deleteTrace(db(), project.id, PROD);
    expect(await envDay(project.id, `production:${DAY}`)).toMatchObject({ traces: 0, spans: 0 });
    const scoresAfter = (await envDay(project.id, `production:${today}`))?.scores as
      Record<string, { count?: number }> | undefined;
    expect(Object.values(scoresAfter ?? {}).every((s) => (s.count ?? 0) === 0)).toBe(true);
    expect((await getProjectStats(db(), project.id, "7d", "production", NOW)).totals.traces).toBe(
      0,
    );
    expect((await getProjectStats(db(), project.id, "7d", undefined, NOW)).totals.traces).toBe(2);
    expect(ids((await list(legacy.plaintext, "?environment=production")).body)).toEqual([]);
  });

  it("revoking or deleting a key leaves its traces and their environment intact", async () => {
    const { project, production, legacy } = await seed();
    await revokeApiKey(db(), project.id, production.key.id);
    expect(ids((await list(legacy.plaintext, "?environment=production")).body)).toEqual([PROD]);
    await db().collection("apiKeys").doc(production.key.id).delete();
    expect(ids((await list(legacy.plaintext, "?environment=production")).body)).toEqual([PROD]);
    expect((await traceData(project.id, PROD))?.environment).toBe("production");
    expect(
      (await callApi<Page>({ path: "/api/v1/traces", apiKey: production.plaintext })).status,
    ).toBe(401);
  });

  it("changing a key's environment only affects traces recorded afterwards", async () => {
    const { project, preview, legacy } = await seed();
    await setApiKeyEnvironment(db(), project.id, preview.key.id, "staging");
    const later = "d4".repeat(16);
    expect((await postTrace(sampleTraceRequest({ id: later }), preview.plaintext)).status).toBe(
      201,
    );
    expect((await traceData(project.id, later))?.environment).toBe("staging");
    expect((await traceData(project.id, PREV))?.environment).toBe("preview");
    expect(ids((await list(legacy.plaintext, "?environment=staging")).body)).toEqual([later]);
    expect(ids((await list(legacy.plaintext, "?environment=preview")).body)).toEqual([PREV]);
    expect(await envDayIds(project.id)).toContain(`staging:${DAY}`);
  });

  it("list_traces over MCP takes the same environment filter", async () => {
    const { legacy } = await seed();
    const prod = await mcpTool(legacy.plaintext, "list_traces", { environment: "production" });
    const structured = prod.result?.structuredContent as {
      traces: Array<{ id: string; environment: string | null }>;
    };
    expect(structured.traces).toEqual([
      expect.objectContaining({ id: PROD, environment: "production" }),
    ]);
    expect(prod.text).toContain("[production]");
    const none = await mcpTool(legacy.plaintext, "list_traces", { environment: "unassigned" });
    expect(
      (none.result?.structuredContent as { traces: Array<{ id: string }> }).traces.map((t) => t.id),
    ).toEqual([NONE]);
    const bad = await mcpTool(legacy.plaintext, "list_traces", { environment: "not valid" });
    expect(bad.result?.isError).toBe(true);
  });

  it("backfill-environment marks pre-environment history and assigns it by tag, key, time or overwrite", async () => {
    const project = await createTestProject("history");
    const legacy = await key(project.id, "legacy", null);
    const L1 = "11".repeat(16);
    const L2 = "22".repeat(16);
    const L3 = "33".repeat(16);
    const tagged = sampleTraceRequest({ id: L1 });
    tagged.trace.tags = ["env:preview"];
    expect((await postTrace(tagged, legacy.plaintext)).status).toBe(201);
    expect((await postTrace(sampleTraceRequest({ id: L2 }), legacy.plaintext)).status).toBe(201);
    expect(
      (
        await postTrace(
          sampleTraceRequest({ id: L3, startedAt: "2026-08-01T10:00:00.000Z" }),
          legacy.plaintext,
        )
      ).status,
    ).toBe(201);
    // Traces recorded before environments existed have neither field.
    const traces = db().collection("projects").doc(project.id).collection("traces");
    for (const id of [L1, L2, L3]) {
      await traces.doc(id).update({
        environment: FieldValue.delete(),
        keyId: FieldValue.delete(),
      });
    }
    await db()
      .collection("projects")
      .doc(project.id)
      .collection("statsByEnv")
      .doc(`_unassigned:${DAY}`)
      .delete();
    expect(ids((await list(legacy.plaintext, "?environment=unassigned")).body)).toEqual([]);

    // Dry run: reports, writes nothing.
    const dry = await assignEnvironment(db(), {
      projectId: project.id,
      environment: null,
      overwrite: false,
      apply: false,
    });
    expect(dry).toMatchObject({ scanned: 3, matched: 3, updated: 0 });
    expect(ids((await list(legacy.plaintext, "?environment=unassigned")).body)).toEqual([]);

    // Mark history: every trace without the field becomes explicitly unassigned.
    const marked = await assignEnvironment(db(), {
      projectId: project.id,
      environment: null,
      overwrite: false,
      apply: true,
    });
    expect(marked).toMatchObject({ scanned: 3, matched: 3, updated: 3 });
    expect(ids((await list(legacy.plaintext, "?environment=unassigned")).body)).toEqual([
      L2,
      L1,
      L3,
    ]);
    expect(await envDayIds(project.id)).toEqual(["_unassigned:2026-08-01", `_unassigned:${DAY}`]);

    // By tag (the old env:* convention).
    const byTag = await assignEnvironment(db(), {
      projectId: project.id,
      environment: "preview",
      tag: "env:preview",
      overwrite: false,
      apply: true,
    });
    expect(byTag).toMatchObject({ matched: 1, updated: 1 });
    expect((await traceData(project.id, L1))?.environment).toBe("preview");
    expect(ids((await list(legacy.plaintext, "?environment=preview")).body)).toEqual([L1]);

    // By key: only traces that recorded which key sent them (ingested since the upgrade).
    const L4 = "44".repeat(16);
    expect((await postTrace(sampleTraceRequest({ id: L4 }), legacy.plaintext)).status).toBe(201);
    const byKey = await assignEnvironment(db(), {
      projectId: project.id,
      environment: "development",
      keyId: legacy.key.id,
      overwrite: false,
      apply: true,
    });
    expect(byKey).toMatchObject({ matched: 1, updated: 1 });
    expect((await traceData(project.id, L4))?.environment).toBe("development");
    expect((await traceData(project.id, L2))?.environment).toBeNull();

    // By time window.
    const byTime = await assignEnvironment(db(), {
      projectId: project.id,
      environment: "qa",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      overwrite: false,
      apply: true,
    });
    expect(byTime).toMatchObject({ matched: 1, updated: 1 });
    expect((await traceData(project.id, L3))?.environment).toBe("qa");

    // Already-assigned traces are left alone unless --overwrite is given.
    const kept = await assignEnvironment(db(), {
      projectId: project.id,
      environment: "production",
      tag: "env:preview",
      overwrite: false,
      apply: true,
    });
    expect(kept).toMatchObject({ matched: 0, updated: 0 });
    const overwritten = await assignEnvironment(db(), {
      projectId: project.id,
      environment: "production",
      tag: "env:preview",
      overwrite: true,
      apply: true,
    });
    expect(overwritten).toMatchObject({ matched: 1, updated: 1 });
    expect((await traceData(project.id, L1))?.environment).toBe("production");

    // Rollups moved with the traces; the all-environment rollup is unchanged.
    expect(await envDayIds(project.id)).toEqual([
      `_unassigned:${DAY}`,
      `development:${DAY}`,
      `production:${DAY}`,
      "qa:2026-08-01",
    ]);
    expect(await envDay(project.id, `_unassigned:${DAY}`)).toMatchObject({ traces: 1 });
    expect(await envDay(project.id, `production:${DAY}`)).toMatchObject({ traces: 1 });
    const allDay = await db()
      .collection("projects")
      .doc(project.id)
      .collection("stats")
      .doc(DAY)
      .get();
    expect(allDay.data()).toMatchObject({ traces: 3 });
    expect((await getProjectStats(db(), project.id, "7d", "production", NOW)).totals.traces).toBe(
      1,
    );
  });
});
