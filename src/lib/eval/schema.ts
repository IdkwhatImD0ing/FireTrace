import { z } from "zod";
import { describeIssues, scoreNameSchema, type ScoreDataType } from "@/lib/firetrace/schema";

/**
 * An evaluator is a stored LLM-as-a-judge definition: a prompt template with
 * `{{input}}`-style variables and the shape of the score it produces. Running
 * it on a trace writes a score whose name is the evaluator's name.
 */

export const EVAL_LIMITS = {
  maxDescriptionLength: 500,
  maxPromptChars: 20_000,
  maxChoices: 20,
  maxChoiceLength: 64,
  maxModelLength: 200,
  /** Per rendered variable; longer inputs are cut with a marker. */
  maxVariableChars: 20_000,
  /** Traces per bulk run. */
  maxBulkTraces: 50,
  bulkConcurrency: 4,
} as const;

export const PROMPT_VARIABLES = ["input", "output", "metadata", "name", "spans"] as const;

const numericOutput = z
  .strictObject({ kind: z.literal("numeric"), min: z.number(), max: z.number() })
  .refine((o) => o.min < o.max, { message: "min must be below max", path: ["max"] });

const categoricalOutput = z
  .strictObject({
    kind: z.literal("categorical"),
    choices: z
      .array(z.string().trim().min(1).max(EVAL_LIMITS.maxChoiceLength))
      .min(2)
      .max(EVAL_LIMITS.maxChoices),
  })
  .refine((o) => new Set(o.choices.map((c) => c.toLowerCase())).size === o.choices.length, {
    message: "choices must be distinct",
    path: ["choices"],
  });

const booleanOutput = z.strictObject({ kind: z.literal("boolean") });

export const outputTypeSchema = z.discriminatedUnion("kind", [
  numericOutput,
  categoricalOutput,
  booleanOutput,
]);
export type EvaluatorOutputType = z.infer<typeof outputTypeSchema>;

export const evaluatorInputSchema = z.strictObject({
  name: scoreNameSchema,
  description: z.string().trim().max(EVAL_LIMITS.maxDescriptionLength).default(""),
  promptTemplate: z.string().min(1).max(EVAL_LIMITS.maxPromptChars),
  outputType: outputTypeSchema,
  model: z.string().trim().min(1).max(EVAL_LIMITS.maxModelLength).optional(),
});
export type EvaluatorInput = z.infer<typeof evaluatorInputSchema>;

export interface Evaluator {
  id: string;
  /** Doubles as the name of the score it writes. */
  name: string;
  description: string;
  promptTemplate: string;
  outputType: EvaluatorOutputType;
  /** Overrides FIRETRACE_EVAL_MODEL when set. */
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EvalRunStatus = "running" | "ok" | "failed";

export interface EvalRun {
  id: string;
  evaluatorId: string;
  /** Snapshot of the evaluator's name, so history survives renames and deletion. */
  evaluatorName: string;
  traceId: string;
  trigger: "manual" | "bulk";
  status: EvalRunStatus;
  model: string | null;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  durationMs: number | null;
  error: string | null;
  scoreId: string | null;
  createdAt: string;
}

export type NormalizeEvaluatorResult =
  | { ok: true; value: EvaluatorInput }
  | { ok: false; error: { code: "invalid_request"; message: string } };

/** Validate an evaluator definition from a form or an API body. Never throws. */
export function normalizeEvaluatorInput(body: unknown): NormalizeEvaluatorResult {
  const parsed = evaluatorInputSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_request", message: describeIssues(parsed.error) } };
  }
  return { ok: true, value: parsed.data };
}

export function outputDataType(outputType: EvaluatorOutputType): ScoreDataType {
  return outputType.kind;
}
