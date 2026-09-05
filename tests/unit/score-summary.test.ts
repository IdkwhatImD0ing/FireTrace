import { describe, expect, it } from "vitest";
import { summarizeScores } from "@/lib/firetrace/scores";
import type { Score } from "@/lib/firetrace/types";
import { formatScoreValue } from "@/lib/format";

function score(partial: Partial<Score> & Pick<Score, "name" | "dataType" | "value">): Score {
  return {
    id: "0123456789abcdef",
    traceId: "a".repeat(32),
    spanId: null,
    comment: null,
    source: "api",
    evaluatorId: null,
    runId: null,
    createdAt: "2026-09-03T10:00:00.000Z",
    ...partial,
  };
}

describe("summarizeScores", () => {
  it("averages numeric scores and counts labels, most frequent name first", () => {
    const summaries = summarizeScores([
      score({ name: "accuracy", dataType: "numeric", value: 0.5 }),
      score({ name: "accuracy", dataType: "numeric", value: 1 }),
      score({ name: "topic", dataType: "categorical", value: "billing" }),
      score({ name: "topic", dataType: "categorical", value: "billing" }),
      score({ name: "topic", dataType: "categorical", value: "refund" }),
      score({ name: "helpful", dataType: "boolean", value: true }),
    ]);
    expect(summaries.map((s) => s.name)).toEqual(["topic", "accuracy", "helpful"]);
    expect(summaries[1]).toEqual({
      name: "accuracy",
      dataType: "numeric",
      count: 2,
      average: 0.75,
      values: [],
    });
    expect(summaries[0].values).toEqual([
      { label: "billing", count: 2 },
      { label: "refund", count: 1 },
    ]);
    expect(summaries[2]).toMatchObject({ average: null, values: [{ label: "true", count: 1 }] });
  });

  it("handles an empty list", () => {
    expect(summarizeScores([])).toEqual([]);
  });
});

describe("formatScoreValue", () => {
  it("keeps integers and labels, rounds fractions to three decimals", () => {
    expect(formatScoreValue(1)).toBe("1");
    expect(formatScoreValue(0.8)).toBe("0.8");
    expect(formatScoreValue(2 / 3)).toBe("0.667");
    expect(formatScoreValue("billing")).toBe("billing");
    expect(formatScoreValue(false)).toBe("false");
  });
});
