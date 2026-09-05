import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createEvaluator,
  deleteEvaluator,
  getEvaluator,
  listEvalRuns,
  listEvaluators,
  updateEvaluator,
} from "@/lib/eval/evaluators";
import { previewEvaluator, runEvaluator, runEvaluatorBulk } from "@/lib/eval/run";
import type { EvaluatorInput } from "@/lib/eval/schema";
import { deleteProject, deleteTrace } from "@/lib/firetrace/projects";
import { getTrace } from "@/lib/firetrace/queries";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { listScoresForTrace } from "@/lib/firetrace/scores";
import { clearFirestore, createTestKey, createTestProject, db, postTrace } from "./helpers";

const T1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const T2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const cfg = { baseUrl: "https://judge.test/v1", apiKey: "sk-judge", model: "judge-default" };

const definition: EvaluatorInput = {
  name: "helpful",
  description: "Was the answer helpful?",
  promptTemplate: "Q: {{input}}\nA: {{output}}\nWas this helpful?",
  outputType: { kind: "boolean" },
};

function completion(content: string) {
  return {
    model: "judge-default-2026",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
  };
}

/** Fake judge endpoint: answers from a queue, then keeps saying "true". */
function judge(answers: Array<{ status?: number; body: unknown }> = []) {
  const requests: Array<Record<string, unknown>> = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = answers.shift() ?? {
      body: completion('{"value": true, "reasoning": "It answered the question."}'),
    };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

async function seed() {
  const project = await createTestProject("evals");
  const key = await createTestKey(project.id, "ingest");
  for (const id of [T1, T2]) {
    expect((await postTrace(sampleTraceRequest({ id }), key.plaintext)).status).toBe(201);
  }
  return project;
}

async function runDocs(projectId: string) {
  const snap = await db().collection("projects").doc(projectId).collection("evalRuns").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
}

describe("evaluators against the emulator", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("creates, lists, updates and deletes evaluator definitions", async () => {
    const project = await seed();
    const created = await createEvaluator(db(), project.id, definition);
    expect(created).toMatchObject({ ...definition, model: null });
    expect(created.id).toMatch(/^[0-9a-f]{16}$/);
    expect(created.createdAt).toMatch(/^\d{4}-/);

    const other = await createEvaluator(db(), project.id, {
      ...definition,
      name: "accuracy",
      outputType: { kind: "numeric", min: 0, max: 1 },
      model: "judge-large",
    });
    expect((await listEvaluators(db(), project.id)).map((e) => e.name)).toEqual([
      "accuracy",
      "helpful",
    ]);
    expect(await getEvaluator(db(), project.id, other.id)).toMatchObject({
      model: "judge-large",
      outputType: { kind: "numeric", min: 0, max: 1 },
    });

    const updated = await updateEvaluator(db(), project.id, created.id, {
      ...definition,
      description: "renamed",
      outputType: { kind: "categorical", choices: ["yes", "no"] },
    });
    expect(updated.description).toBe("renamed");
    expect(updated.outputType).toEqual({ kind: "categorical", choices: ["yes", "no"] });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt));

    await deleteEvaluator(db(), project.id, created.id);
    expect(await getEvaluator(db(), project.id, created.id)).toBeNull();
    await expect(deleteEvaluator(db(), project.id, created.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(updateEvaluator(db(), project.id, "not-an-id", definition)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("runs the judge, writes an eval score and logs the run; reruns skip unless forced", async () => {
    const project = await seed();
    const evaluator = await createEvaluator(db(), project.id, definition);
    const { impl, requests } = judge();

    const first = await runEvaluator(db(), cfg, project.id, evaluator, T1, {
      trigger: "manual",
      fetchImpl: impl,
      retryDelayMs: 0,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");
    expect(first.score).toMatchObject({
      name: "helpful",
      dataType: "boolean",
      value: true,
      comment: "It answered the question.",
      source: "eval",
      evaluatorId: evaluator.id,
      runId: first.runId,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "judge-default", temperature: 0 });
    expect(requests[0].response_format).toMatchObject({ type: "json_schema" });
    const messages = requests[0].messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain("Was this helpful?");
    expect(messages[1].content).not.toContain("{{input}}");

    const trace = (await getTrace(db(), project.id, T1))!;
    expect(trace.scores.helpful).toMatchObject({ value: true, evaluatorId: evaluator.id });

    const skipped = await runEvaluator(db(), cfg, project.id, evaluator, T1, {
      trigger: "manual",
      fetchImpl: impl,
    });
    expect(skipped).toMatchObject({ status: "skipped", runId: null });
    expect(requests).toHaveLength(1);

    const forced = await runEvaluator(db(), cfg, project.id, evaluator, T1, {
      trigger: "manual",
      force: true,
      fetchImpl: impl,
    });
    expect(forced.status).toBe("ok");
    expect(await listScoresForTrace(db(), project.id, T1)).toHaveLength(2);

    const runs = await listEvalRuns(db(), project.id, { evaluatorId: evaluator.id });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      evaluatorName: "helpful",
      traceId: T1,
      trigger: "manual",
      status: "ok",
      model: "judge-default-2026",
      usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
    });
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(runs[0].scoreId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records a failed run without a score when the judge answers nonsense", async () => {
    const project = await seed();
    const evaluator = await createEvaluator(db(), project.id, definition);
    const { impl } = judge([{ body: completion("I would rather not say.") }]);
    const outcome = await runEvaluator(db(), cfg, project.id, evaluator, T1, {
      trigger: "manual",
      fetchImpl: impl,
    });
    expect(outcome).toMatchObject({ status: "failed" });
    expect((outcome as { error: string }).error).toContain("did not return JSON");
    expect(await listScoresForTrace(db(), project.id, T1)).toEqual([]);
    const runs = await listEvalRuns(db(), project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", scoreId: null });
    expect(runs[0].error).toContain("did not return JSON");
  });

  it("falls back to a plain request when the endpoint rejects response_format", async () => {
    const project = await seed();
    const evaluator = await createEvaluator(db(), project.id, {
      ...definition,
      name: "accuracy",
      outputType: { kind: "numeric", min: 0, max: 1 },
    });
    const { impl, requests } = judge([
      { status: 400, body: { error: { message: "response_format is not supported" } } },
      { body: completion('Score: {"value": "0.75", "reasoning": "mostly right"}') },
    ]);
    const outcome = await runEvaluator(db(), cfg, project.id, evaluator, T1, {
      trigger: "manual",
      fetchImpl: impl,
      retryDelayMs: 0,
    });
    expect(outcome).toMatchObject({ status: "ok" });
    expect(requests).toHaveLength(2);
    expect(requests[0].response_format).toBeDefined();
    expect(requests[1].response_format).toBeUndefined();
    expect((outcome as { score: { value: number } }).score.value).toBe(0.75);
  });

  it("runs in bulk with a summary and previews without writing", async () => {
    const project = await seed();
    const evaluator = await createEvaluator(db(), project.id, definition);
    const { impl } = judge();

    const bulk = await runEvaluatorBulk(db(), cfg, project.id, evaluator, [T1, T2], {
      fetchImpl: impl,
    });
    expect(bulk).toMatchObject({ ok: 2, skipped: 0, failed: 0 });
    expect(bulk.results.map((r) => r.traceId).sort()).toEqual([T1, T2]);
    // Already scored: a second pass skips both without calling the judge.
    const again = await runEvaluatorBulk(db(), cfg, project.id, evaluator, [T1, T2], {
      fetchImpl: impl,
    });
    expect(again).toMatchObject({ ok: 0, skipped: 2, failed: 0 });
    const runs = await listEvalRuns(db(), project.id);
    expect(runs.map((r) => r.trigger)).toEqual(["bulk", "bulk"]);

    const preview = await previewEvaluator(
      db(),
      cfg,
      project.id,
      { ...definition, name: "draft" },
      T2,
      { fetchImpl: impl },
    );
    expect(preview.rendered).toContain("Was this helpful?");
    expect(preview.parsed).toMatchObject({ ok: true, value: true });
    expect(preview.model).toBe("judge-default-2026");
    expect(await listScoresForTrace(db(), project.id, T2)).toHaveLength(1);
    expect(await listEvalRuns(db(), project.id)).toHaveLength(2);

    await expect(
      previewEvaluator(db(), cfg, project.id, definition, "0".repeat(32), { fetchImpl: impl }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("deleting a trace removes its runs; deleting the project removes everything", async () => {
    const project = await seed();
    const evaluator = await createEvaluator(db(), project.id, definition);
    const { impl } = judge();
    await runEvaluatorBulk(db(), cfg, project.id, evaluator, [T1, T2], { fetchImpl: impl });
    expect(await runDocs(project.id)).toHaveLength(2);

    await deleteTrace(db(), project.id, T1);
    const remaining = await runDocs(project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].traceId).toBe(T2);

    const removed = await deleteProject(db(), project.id);
    expect(removed).toMatchObject({ traces: 1, scores: 1, evaluators: 1, evalRuns: 1 });
    expect(await runDocs(project.id)).toEqual([]);
    expect(await listEvaluators(db(), project.id)).toEqual([]);
  });
});
