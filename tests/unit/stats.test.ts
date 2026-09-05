import { describe, expect, it } from "vitest";
import { buildStats, parseRange, percentile, rangeWindow } from "@/lib/firetrace/stats";
import {
  bucketMidpointMs,
  encodeKey,
  latencyBucket,
  OTHER_KEY,
  type StatsDayDoc,
} from "@/lib/firetrace/stats-rollup";

const NOW = Date.parse("2026-09-04T21:30:00.000Z");

describe("parseRange and rangeWindow", () => {
  it("defaults to 7d and accepts the known ranges", () => {
    expect(parseRange(undefined)).toBe("7d");
    expect(parseRange("1y")).toBe("7d");
    expect(parseRange(["30d"])).toBe("30d");
    expect(parseRange("24h")).toBe("24h");
  });

  it("builds UTC day buckets ending today", () => {
    const w = rangeWindow("7d", NOW);
    expect(w.hourly).toBe(false);
    expect(w.fromDay).toBe("2026-08-29");
    expect(w.toDay).toBe("2026-09-04");
    expect(w.buckets.map((b) => b.key)).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
    expect(w.buckets[0].label).toBe("Aug 29");
    expect(rangeWindow("90d", NOW).buckets).toHaveLength(90);
  });

  it("builds 24 hourly buckets that can straddle two days", () => {
    const w = rangeWindow("24h", NOW);
    expect(w.hourly).toBe(true);
    expect(w.buckets).toHaveLength(24);
    expect(w.buckets[0]).toEqual({ key: "2026-09-03T22", label: "22:00" });
    expect(w.buckets[23]).toEqual({ key: "2026-09-04T21", label: "21:00" });
    expect(w.fromDay).toBe("2026-09-03");
    expect(w.toDay).toBe("2026-09-04");
  });
});

describe("percentile", () => {
  it("returns the midpoint of the bucket holding the percentile", () => {
    const hist = { [String(latencyBucket(100))]: 9, [String(latencyBucket(10_000))]: 1 };
    expect(percentile(hist, 0.5)).toBeCloseTo(bucketMidpointMs(latencyBucket(100)), 6);
    expect(percentile(hist, 0.95)).toBeCloseTo(bucketMidpointMs(latencyBucket(10_000)), 6);
    // Within ±19% of the true value by construction.
    expect(percentile(hist, 0.5)! / 100).toBeGreaterThan(0.8);
    expect(percentile(hist, 0.5)! / 100).toBeLessThan(1.2);
    expect(percentile({}, 0.5)).toBeNull();
    expect(percentile(undefined, 0.5)).toBeNull();
    expect(percentile({ "3": -4 }, 0.5)).toBeNull();
  });
});

describe("buildStats", () => {
  const answer = encodeKey("answer-question");
  const model = encodeKey("example-model");
  const day = (traces: number, errors: number): StatsDayDoc => ({
    traces,
    errors,
    spans: traces * 5,
    inputTokens: traces * 400,
    outputTokens: traces * 100,
    totalTokens: traces * 500,
    costUsd: traces * 0.001,
    durationMsSum: traces * 2000,
    hours: { "19": { traces, errors, costUsd: traces * 0.001, totalTokens: traces * 500 } },
    byModel: {
      [model]: {
        traces,
        inputTokens: traces * 400,
        outputTokens: traces * 100,
        costUsd: traces * 0.001,
      },
    },
    byName: {
      [answer]: {
        traces,
        errors,
        durationMsSum: traces * 2000,
        hist: { [String(latencyBucket(2000))]: traces },
      },
    },
    scores: {
      [encodeKey("accuracy")]: { count: traces, sum: traces * 0.5 },
      [encodeKey("helpful")]: { count: traces, values: { [encodeKey("true")]: traces } },
    },
  });

  it("merges day documents into totals, series and top tables", () => {
    const window = rangeWindow("7d", NOW);
    const stats = buildStats(window, [
      { id: "2026-09-02", data: day(4, 1) },
      { id: "2026-09-04", data: day(2, 0) },
    ]);
    expect(stats.days).toBe(2);
    expect(stats.totals).toEqual({
      traces: 6,
      errors: 1,
      errorRate: 1 / 6,
      costUsd: 0.006,
      totalTokens: 3000,
      avgMs: 2000,
    });
    expect(stats.series.map((p) => p.traces)).toEqual([0, 0, 0, 0, 4, 0, 2]);
    expect(stats.series[4]).toMatchObject({ key: "2026-09-02", errors: 1, totalTokens: 2000 });
    expect(stats.byName).toEqual([
      {
        name: "answer-question",
        traces: 6,
        errors: 1,
        avgMs: 2000,
        p50: bucketMidpointMs(latencyBucket(2000)),
        p90: bucketMidpointMs(latencyBucket(2000)),
        p95: bucketMidpointMs(latencyBucket(2000)),
        p99: bucketMidpointMs(latencyBucket(2000)),
      },
    ]);
    expect(stats.byModel).toEqual([
      { model: "example-model", traces: 6, inputTokens: 2400, outputTokens: 600, costUsd: 0.006 },
    ]);
    expect(stats.scores).toEqual([
      { name: "accuracy", count: 6, average: 0.5, values: [] },
      { name: "helpful", count: 6, average: null, values: [{ label: "true", count: 6 }] },
    ]);
  });

  it("uses hourly buckets for 24h and clamps negative leftovers", () => {
    const window = rangeWindow("24h", NOW);
    const doc: StatsDayDoc = {
      ...day(3, 0),
      traces: -2,
      hours: { "21": { traces: 3, errors: 0, costUsd: 0.003, totalTokens: 1500 } },
      byModel: { [OTHER_KEY]: { traces: -1, costUsd: 0 } },
    };
    const stats = buildStats(window, [{ id: "2026-09-04", data: doc }]);
    expect(stats.hourly).toBe(true);
    expect(stats.totals.traces).toBe(0);
    expect(stats.totals.errorRate).toBeNull();
    expect(stats.series.at(-1)).toMatchObject({ key: "2026-09-04T21", traces: 3 });
    expect(stats.series[0].traces).toBe(0);
    expect(stats.byModel).toEqual([]);
  });

  it("is empty without documents", () => {
    const stats = buildStats(rangeWindow("30d", NOW), []);
    expect(stats.days).toBe(0);
    expect(stats.series).toHaveLength(30);
    expect(stats.totals.traces).toBe(0);
    expect(stats.byName).toEqual([]);
  });
});
