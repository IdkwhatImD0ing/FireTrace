import { describe, expect, it } from "vitest";
import {
  judgeJsonSchema,
  judgeMessages,
  judgeResponseFormat,
  parseJudgeOutput,
  renderPrompt,
} from "@/lib/eval/prompt";
import {
  EVAL_LIMITS,
  normalizeEvaluatorInput,
  PROMPT_VARIABLES,
  type EvaluatorOutputType,
} from "@/lib/eval/schema";
import { BUILT_IN_TEMPLATES } from "@/lib/eval/templates";
import type { SpanDetail, TraceDetail } from "@/lib/firetrace/types";

const trace: TraceDetail = {
  id: "a".repeat(32),
  name: "answer-question",
  status: "ok",
  startedAt: "2026-09-02T19:01:02.120Z",
  endedAt: "2026-09-02T19:01:04.812Z",
  durationMs: 2692,
  provider: null,
  model: "example-model",
  sessionId: null,
  userId: null,
  tags: [],
  usage: {},
  costUsd: null,
  spanCount: 2,
  errorCount: 1,
  estimatedBytes: 100,
  ingestedAt: null,
  scores: {},
  environment: null,
  schemaVersion: 1,
  bodyHash: "",
  input: "What is the refund policy?",
  output: { answer: "30 days", citations: ["policy.md"] },
  metadata: {},
  metadataUpdatedAt: null,
};

function span(partial: Partial<SpanDetail> & Pick<SpanDetail, "id" | "name">): SpanDetail {
  return {
    traceId: trace.id,
    parentSpanId: null,
    kind: "custom",
    status: "ok",
    startedAt: "2026-09-02T19:01:02.120Z",
    endedAt: "2026-09-02T19:01:02.620Z",
    durationMs: 500,
    provider: null,
    model: null,
    input: null,
    output: null,
    attributes: {},
    events: [],
    usage: null,
    costUsd: null,
    ...partial,
  };
}

const spans = [
  span({ id: "1111111111111111", name: "agent", kind: "agent" }),
  span({
    id: "2222222222222222",
    name: "lookup",
    kind: "tool",
    status: "error",
    parentSpanId: "1111111111111111",
    startedAt: "2026-09-02T19:01:02.200Z",
    durationMs: 120,
    model: "search-1",
  }),
];

const numeric: EvaluatorOutputType = { kind: "numeric", min: 0, max: 1 };
const categorical: EvaluatorOutputType = { kind: "categorical", choices: ["billing", "sales"] };
const boolean: EvaluatorOutputType = { kind: "boolean" };

describe("renderPrompt", () => {
  it("substitutes every variable, keeps unknown ones and tolerates spacing", () => {
    const rendered = renderPrompt(
      "N={{name}} I={{ input }} O={{output}} M={{metadata}} S=\n{{spans}} X={{unknown}}",
      trace,
      spans,
    );
    expect(rendered).toContain("N=answer-question");
    expect(rendered).toContain("I=What is the refund policy?");
    expect(rendered).toContain('"answer": "30 days"');
    expect(rendered).toContain("M=(none)");
    expect(rendered).toContain("- [agent] agent (ok, 500 ms)");
    expect(rendered).toContain("  - [tool] lookup (error, 120 ms, search-1)");
    expect(rendered).toContain("X={{unknown}}");
  });

  it("caps each variable and marks the cut", () => {
    const long = { ...trace, input: "x".repeat(EVAL_LIMITS.maxVariableChars + 50) };
    const rendered = renderPrompt("{{input}}", long, []);
    expect(rendered).toHaveLength(
      EVAL_LIMITS.maxVariableChars + "\n…[truncated 50 characters]".length,
    );
    expect(rendered.endsWith("…[truncated 50 characters]")).toBe(true);
    expect(renderPrompt("{{spans}}", trace, [])).toBe("(no spans)");
  });
});

describe("judge messages and schemas", () => {
  it("describe the expected value per output type", () => {
    expect(judgeMessages("p", numeric)[0].content).toContain("a number between 0 and 1");
    expect(judgeMessages("p", categorical)[0].content).toContain('one of "billing", "sales"');
    expect(judgeMessages("p", boolean)[0].content).toContain("true or false");
    expect(judgeMessages("the prompt", boolean)[1]).toEqual({
      role: "user",
      content: "the prompt",
    });
  });

  it("build a strict JSON schema with a sanitized name", () => {
    expect(judgeJsonSchema(numeric)).toEqual({
      type: "object",
      properties: {
        value: { type: "number", minimum: 0, maximum: 1 },
        reasoning: { type: "string" },
      },
      required: ["value", "reasoning"],
      additionalProperties: false,
    });
    expect(judgeJsonSchema(categorical)).toMatchObject({
      properties: { value: { type: "string", enum: ["billing", "sales"] } },
    });
    const format = judgeResponseFormat("my-eval", boolean) as {
      type: string;
      json_schema: { name: string; strict: boolean };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema).toMatchObject({ name: "firetrace_my-eval", strict: true });
  });
});

describe("parseJudgeOutput", () => {
  it("accepts plain, fenced and prose-wrapped JSON", () => {
    expect(parseJudgeOutput('{"value": 0.8, "reasoning": " solid "}', numeric)).toEqual({
      ok: true,
      value: 0.8,
      reasoning: "solid",
    });
    expect(parseJudgeOutput('```json\n{"value": true}\n```', boolean)).toEqual({
      ok: true,
      value: true,
      reasoning: null,
    });
    expect(
      parseJudgeOutput(
        'Sure! Here it is: {"value": "billing", "reasoning": ""} Hope it helps.',
        categorical,
      ),
    ).toMatchObject({ ok: true, value: "billing", reasoning: null });
  });

  it("coerces the usual near-misses", () => {
    expect(parseJudgeOutput('{"value": "0.5"}', numeric)).toMatchObject({ ok: true, value: 0.5 });
    expect(parseJudgeOutput('{"value": "yes"}', boolean)).toMatchObject({ ok: true, value: true });
    expect(parseJudgeOutput('{"value": "Billing"}', categorical)).toMatchObject({
      ok: true,
      value: "billing",
    });
    expect(parseJudgeOutput("false", boolean)).toMatchObject({ ok: true, value: false });
  });

  it("rejects values outside the output type and non-JSON text", () => {
    expect(parseJudgeOutput('{"value": 7}', numeric)).toMatchObject({ ok: false });
    expect(parseJudgeOutput('{"value": "refund"}', categorical)).toMatchObject({ ok: false });
    expect(parseJudgeOutput('{"value": "maybe"}', boolean)).toMatchObject({ ok: false });
    expect(parseJudgeOutput("I cannot judge this.", numeric)).toEqual({
      ok: false,
      error: "The judge did not return JSON.",
    });
  });
});

describe("evaluator schema and templates", () => {
  it("validates every built-in template and its variables", () => {
    const ids = new Set<string>();
    for (const template of BUILT_IN_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      const result = normalizeEvaluatorInput({
        name: template.name,
        description: template.description,
        promptTemplate: template.promptTemplate,
        outputType: template.outputType,
      });
      expect(result.ok, template.id).toBe(true);
      for (const match of template.promptTemplate.matchAll(/\{\{\s*([A-Za-z]+)\s*\}\}/g)) {
        expect(PROMPT_VARIABLES as readonly string[], `${template.id}: ${match[1]}`).toContain(
          match[1],
        );
      }
    }
  });

  it("refuses inverted ranges, duplicate choices and bad names", () => {
    const base = { name: "ok", promptTemplate: "{{input}}" };
    const failure = (body: unknown) => {
      const r = normalizeEvaluatorInput(body);
      if (r.ok) throw new Error("expected failure");
      return r.error.message;
    };
    expect(failure({ ...base, outputType: { kind: "numeric", min: 1, max: 1 } })).toContain("max");
    expect(
      failure({ ...base, outputType: { kind: "categorical", choices: ["a", "A"] } }),
    ).toContain("distinct");
    expect(failure({ ...base, outputType: { kind: "categorical", choices: ["only"] } })).toContain(
      "choices",
    );
    expect(failure({ ...base, name: "has space", outputType: { kind: "boolean" } })).toContain(
      "name",
    );
    expect(failure({ ...base, outputType: { kind: "boolean" }, extra: 1 })).toContain("extra");
    const ok = normalizeEvaluatorInput({ ...base, outputType: { kind: "boolean" }, model: " m " });
    expect(ok.ok && ok.value.model).toBe("m");
    expect(ok.ok && ok.value.description).toBe("");
  });
});
