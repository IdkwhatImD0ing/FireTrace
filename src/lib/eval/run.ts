import "server-only";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { EvalConfig } from "@/lib/env/server";
import { ApiError } from "@/lib/firetrace/errors";
import { newRunId } from "@/lib/firetrace/ids";
import { getTrace, listSpans } from "@/lib/firetrace/queries";
import { SCORE_LIMITS } from "@/lib/firetrace/schema";
import { addScore } from "@/lib/firetrace/scores";
import type { Score, SpanDetail, TraceDetail } from "@/lib/firetrace/types";
import { log } from "@/lib/log";
import { evalRunRef } from "./evaluators";
import { chatCompletion, LlmError, type ChatCompletionResult } from "./llm";
import { judgeMessages, judgeResponseFormat, parseJudgeOutput, renderPrompt } from "./prompt";
import { EVAL_LIMITS, outputDataType, type Evaluator, type EvaluatorInput } from "./schema";

/**
 * Running an evaluator: render the prompt from the trace, ask the judge for
 * JSON, validate it, and write the verdict as a score with source "eval".
 * Every attempt that reaches the model leaves an `evalRuns` document so cost
 * and failures stay visible.
 */

export interface RunOptions {
  trigger: "manual" | "bulk";
  /** Re-run even when this evaluator already scored the trace. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export type RunOutcome =
  | { status: "ok"; runId: string; score: Score }
  | { status: "skipped"; runId: null; reason: string }
  | { status: "failed"; runId: string | null; error: string };

export interface JudgeCall {
  rendered: string;
  result: ChatCompletionResult;
}

/** What the judge needs from an evaluator; a saved one or an unsaved draft. */
export type JudgeDefinition = Pick<EvaluatorInput, "name" | "promptTemplate" | "outputType"> & {
  model?: string | null;
};

/** Ask the judge once, falling back to a plain request when structured output is refused. */
export async function askJudge(
  cfg: EvalConfig,
  evaluator: JudgeDefinition,
  trace: TraceDetail,
  spans: SpanDetail[],
  options: Pick<RunOptions, "fetchImpl" | "retryDelayMs" | "timeoutMs">,
): Promise<JudgeCall> {
  const rendered = renderPrompt(evaluator.promptTemplate, trace, spans);
  const base = {
    messages: judgeMessages(rendered, evaluator.outputType),
    model: evaluator.model ?? undefined,
    temperature: 0,
    fetchImpl: options.fetchImpl,
    retryDelayMs: options.retryDelayMs,
    timeoutMs: options.timeoutMs,
  };
  try {
    const result = await chatCompletion(cfg, {
      ...base,
      responseFormat: judgeResponseFormat(evaluator.name, evaluator.outputType),
    });
    return { rendered, result };
  } catch (err) {
    // Some OpenAI-compatible servers reject response_format outright.
    if (err instanceof LlmError && err.kind === "http" && err.status === 400) {
      return { rendered, result: await chatCompletion(cfg, base) };
    }
    throw err;
  }
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

async function loadTrace(
  db: Firestore,
  projectId: string,
  traceId: string,
): Promise<{ trace: TraceDetail; spans: SpanDetail[] }> {
  const [trace, spans] = await Promise.all([
    getTrace(db, projectId, traceId),
    listSpans(db, projectId, traceId),
  ]);
  if (!trace) throw new ApiError(404, "not_found", "Trace not found.");
  return { trace, spans };
}

/** Run one evaluator on one trace. Judge and validation failures are returned, not thrown. */
export async function runEvaluator(
  db: Firestore,
  cfg: EvalConfig,
  projectId: string,
  evaluator: Evaluator,
  traceId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const { trace, spans } = await loadTrace(db, projectId, traceId);
  if (!options.force && trace.scores[evaluator.name]?.evaluatorId === evaluator.id) {
    return { status: "skipped", runId: null, reason: "already scored by this evaluator" };
  }

  const runRef = evalRunRef(db, projectId, newRunId());
  const startedAt = Date.now();
  await runRef.create({
    evaluatorId: evaluator.id,
    evaluatorName: evaluator.name,
    traceId,
    trigger: options.trigger,
    status: "running",
    model: evaluator.model ?? cfg.model,
    usage: null,
    durationMs: null,
    error: null,
    scoreId: null,
    createdAt: Timestamp.now(),
  });

  const fail = async (error: string): Promise<RunOutcome> => {
    await runRef.update({ status: "failed", error, durationMs: Date.now() - startedAt });
    log("warn", "eval.run.failed", { projectId, evaluatorId: evaluator.id, traceId });
    return { status: "failed", runId: runRef.id, error };
  };

  let call: JudgeCall;
  try {
    call = await askJudge(cfg, evaluator, trace, spans, options);
  } catch (err) {
    return fail(errorText(err));
  }
  const parsed = parseJudgeOutput(call.result.content, evaluator.outputType);
  if (!parsed.ok) return fail(parsed.error);

  try {
    const score = await addScore(
      db,
      projectId,
      traceId,
      {
        name: evaluator.name,
        dataType: outputDataType(evaluator.outputType),
        value: parsed.value,
        ...(parsed.reasoning
          ? { comment: parsed.reasoning.slice(0, SCORE_LIMITS.maxCommentLength) }
          : {}),
      },
      { source: "eval", evaluatorId: evaluator.id, runId: runRef.id },
    );
    await runRef.update({
      status: "ok",
      model: call.result.model ?? evaluator.model ?? cfg.model,
      usage: call.result.usage,
      durationMs: Date.now() - startedAt,
      scoreId: score.id,
    });
    log("info", "eval.run.completed", {
      projectId,
      evaluatorId: evaluator.id,
      traceId,
      ms: Date.now() - startedAt,
      totalTokens: call.result.usage?.totalTokens ?? null,
    });
    return { status: "ok", runId: runRef.id, score };
  } catch (err) {
    return fail(errorText(err));
  }
}

export interface BulkOutcome {
  ok: number;
  skipped: number;
  failed: number;
  results: Array<{ traceId: string; outcome: RunOutcome }>;
}

/** Run one evaluator over several traces with bounded concurrency; never more than the bulk cap. */
export async function runEvaluatorBulk(
  db: Firestore,
  cfg: EvalConfig,
  projectId: string,
  evaluator: Evaluator,
  traceIds: readonly string[],
  options: Omit<RunOptions, "trigger">,
): Promise<BulkOutcome> {
  const queue = traceIds.slice(0, EVAL_LIMITS.maxBulkTraces);
  const results: BulkOutcome["results"] = [];
  const worker = async () => {
    for (;;) {
      const traceId = queue.shift();
      if (!traceId) return;
      const outcome = await runEvaluator(db, cfg, projectId, evaluator, traceId, {
        ...options,
        trigger: "bulk",
      }).catch((err): RunOutcome => ({ status: "failed", runId: null, error: errorText(err) }));
      results.push({ traceId, outcome });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(EVAL_LIMITS.bulkConcurrency, queue.length) }, worker),
  );
  return {
    ok: results.filter((r) => r.outcome.status === "ok").length,
    skipped: results.filter((r) => r.outcome.status === "skipped").length,
    failed: results.filter((r) => r.outcome.status === "failed").length,
    results,
  };
}

export interface PreviewOutcome {
  rendered: string;
  raw: string;
  parsed: ReturnType<typeof parseJudgeOutput>;
  model: string | null;
  usage: ChatCompletionResult["usage"];
  durationMs: number;
}

/** Dry run for the evaluator form: shows the prompt and the judge's answer, writes nothing. */
export async function previewEvaluator(
  db: Firestore,
  cfg: EvalConfig,
  projectId: string,
  draft: EvaluatorInput,
  traceId: string,
  options: Pick<RunOptions, "fetchImpl" | "retryDelayMs" | "timeoutMs"> = {},
): Promise<PreviewOutcome> {
  const { trace, spans } = await loadTrace(db, projectId, traceId);
  const call = await askJudge(cfg, draft, trace, spans, options);
  return {
    rendered: call.rendered,
    raw: call.result.content,
    parsed: parseJudgeOutput(call.result.content, draft.outputType),
    model: call.result.model,
    usage: call.result.usage,
    durationMs: call.result.durationMs,
  };
}
