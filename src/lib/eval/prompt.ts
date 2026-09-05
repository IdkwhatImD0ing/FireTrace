import { z } from "zod";
import type { JsonValue } from "@/lib/firetrace/schema";
import { buildSpanTree } from "@/lib/firetrace/tree";
import type { SpanDetail, TraceDetail } from "@/lib/firetrace/types";
import type { ChatMessage } from "./llm";
import { EVAL_LIMITS, type EvaluatorOutputType } from "./schema";

/** Pure helpers between an evaluator definition and the judge model. */

function stringify(value: JsonValue | null | undefined): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function cap(text: string): string {
  const max = EVAL_LIMITS.maxVariableChars;
  return text.length > max
    ? `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`
    : text;
}

function spanOutline(spans: SpanDetail[]): string {
  const tree = buildSpanTree(
    spans,
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
  );
  const lines = tree.rows.map((row) => {
    const s = row.span;
    const model = s.model ? `, ${s.model}` : "";
    return `${"  ".repeat(Math.min(row.depth, 8))}- [${s.kind}] ${s.name} (${s.status}, ${s.durationMs} ms${model})`;
  });
  return lines.length ? lines.join("\n") : "(no spans)";
}

/** Substitute `{{input}}`, `{{output}}`, `{{metadata}}`, `{{name}}` and `{{spans}}`; unknown names stay. */
export function renderPrompt(template: string, trace: TraceDetail, spans: SpanDetail[]): string {
  const values: Record<string, () => string> = {
    input: () => stringify(trace.input),
    output: () => stringify(trace.output),
    metadata: () => stringify(Object.keys(trace.metadata).length ? trace.metadata : null),
    name: () => trace.name,
    spans: () => spanOutline(spans),
  };
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, key: string) =>
    key in values ? cap(values[key]()) : match,
  );
}

function valueDescription(outputType: EvaluatorOutputType): string {
  switch (outputType.kind) {
    case "numeric":
      return `a number between ${outputType.min} and ${outputType.max}`;
    case "categorical":
      return `one of ${outputType.choices.map((c) => JSON.stringify(c)).join(", ")}`;
    case "boolean":
      return "true or false";
  }
}

/** System + user messages for the judge; the user message is the rendered prompt. */
export function judgeMessages(rendered: string, outputType: EvaluatorOutputType): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You are a strict evaluator. Read the material and reply with exactly one JSON object of the form {"value": ${valueDescription(outputType)}, "reasoning": "one or two sentences"}. Output nothing before or after the JSON.`,
    },
    { role: "user", content: rendered },
  ];
}

/** JSON Schema for the judge's reply, used for OpenAI-style structured output. */
export function judgeJsonSchema(outputType: EvaluatorOutputType): Record<string, unknown> {
  const value =
    outputType.kind === "numeric"
      ? { type: "number", minimum: outputType.min, maximum: outputType.max }
      : outputType.kind === "categorical"
        ? { type: "string", enum: [...outputType.choices] }
        : { type: "boolean" };
  return {
    type: "object",
    properties: { value, reasoning: { type: "string" } },
    required: ["value", "reasoning"],
    additionalProperties: false,
  };
}

export function judgeResponseFormat(
  name: string,
  outputType: EvaluatorOutputType,
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: `firetrace_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
      strict: true,
      schema: judgeJsonSchema(outputType),
    },
  };
}

export function judgeOutputSchema(outputType: EvaluatorOutputType) {
  const value =
    outputType.kind === "numeric"
      ? z.number().min(outputType.min).max(outputType.max)
      : outputType.kind === "categorical"
        ? z.enum(outputType.choices as [string, ...string[]])
        : z.boolean();
  return z.object({ value, reasoning: z.string().optional() });
}

function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the outermost braces: models sometimes add prose.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Tolerate the usual near-misses: "true" for true, "0.8" for 0.8, a choice in the wrong case. */
function coerceValue(raw: unknown, outputType: EvaluatorOutputType): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (outputType.kind === "boolean") {
    const lower = text.toLowerCase();
    if (["true", "yes"].includes(lower)) return true;
    if (["false", "no"].includes(lower)) return false;
  }
  if (outputType.kind === "numeric" && text && Number.isFinite(Number(text))) return Number(text);
  if (outputType.kind === "categorical") {
    return outputType.choices.find((c) => c.toLowerCase() === text.toLowerCase()) ?? raw;
  }
  return raw;
}

export type JudgeParse =
  | { ok: true; value: number | string | boolean; reasoning: string | null }
  | { ok: false; error: string };

/** Turn the judge's text into a validated score value. Never throws. */
export function parseJudgeOutput(text: string, outputType: EvaluatorOutputType): JudgeParse {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: "The judge did not return JSON." };
  const candidate =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? {
          ...(json as Record<string, unknown>),
          value: coerceValue((json as Record<string, unknown>).value, outputType),
        }
      : { value: coerceValue(json, outputType) };
  const parsed = judgeOutputSchema(outputType).safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `The judge's value did not match the evaluator's output type (${issue?.message ?? "invalid"}).`,
    };
  }
  const reasoning = parsed.data.reasoning?.trim();
  return { ok: true, value: parsed.data.value, reasoning: reasoning ? reasoning : null };
}
