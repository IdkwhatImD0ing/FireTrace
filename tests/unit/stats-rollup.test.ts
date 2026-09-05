import { FieldValue } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  applyDeltas,
  bucketMidpointMs,
  chooseKey,
  decodeKey,
  encodeKey,
  existingKey,
  HIST_BUCKETS,
  hourOf,
  latencyBucket,
  OTHER_KEY,
  scoreStatsDeltas,
  statsDayId,
  statsIncrements,
  traceStatsDeltas,
} from "@/lib/firetrace/stats-rollup";

describe("map keys", () => {
  it("round-trip any name through a Firestore-safe key", () => {
    for (const name of ["gpt-5", "answer.question/v2", "モデル", "a b", "_other-looking"]) {
      const key = encodeKey(name);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(key.startsWith("_")).toBe(false);
      expect(decodeKey(key)).toBe(name);
    }
    expect(encodeKey("")).toBe(OTHER_KEY);
    expect(decodeKey(OTHER_KEY)).toBeNull();
    expect(decodeKey("not base64!!")).toBeNull();
  });

  it("chooseKey honours the cap and existingKey never invents a key", () => {
    const existing = { [encodeKey("a")]: {}, [encodeKey("b")]: {}, [OTHER_KEY]: {} };
    expect(chooseKey(undefined, "a", 2)).toBe(encodeKey("a"));
    expect(chooseKey(existing, "a", 2)).toBe(encodeKey("a"));
    expect(chooseKey(existing, "c", 2)).toBe(OTHER_KEY);
    expect(chooseKey(existing, "c", 3)).toBe(encodeKey("c"));
    expect(chooseKey(existing, null, 3)).toBe(OTHER_KEY);
    expect(existingKey(existing, "b")).toBe(encodeKey("b"));
    expect(existingKey(existing, "zzz")).toBe(OTHER_KEY);
    expect(existingKey(undefined, "a")).toBe(OTHER_KEY);
  });
});

describe("time and latency buckets", () => {
  it("derive the UTC day and hour", () => {
    expect(statsDayId("2026-09-02T19:01:02.120Z")).toBe("2026-09-02");
    expect(hourOf("2026-09-02T19:01:02.120Z")).toBe(19);
    expect(hourOf("2026-09-02T00:30:00.000Z")).toBe(0);
  });

  it("are half-octave, monotonic and bounded", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(1)).toBe(0);
    expect(latencyBucket(2)).toBe(2);
    expect(latencyBucket(1000)).toBe(19);
    expect(latencyBucket(1e12)).toBe(HIST_BUCKETS - 1);
    let previous = -1;
    for (let ms = 1; ms < 1e7; ms *= 1.7) {
      const bucket = latencyBucket(ms);
      expect(bucket).toBeGreaterThanOrEqual(previous);
      previous = bucket;
      // The midpoint sits inside the bucket's own range.
      const lo = Math.pow(2, bucket / 2);
      const hi = Math.pow(2, (bucket + 1) / 2);
      expect(bucketMidpointMs(bucket)).toBeGreaterThanOrEqual(lo);
      expect(bucketMidpointMs(bucket)).toBeLessThan(hi);
    }
  });
});

describe("deltas", () => {
  const trace = {
    name: "answer-question",
    status: "error",
    startedAt: "2026-09-02T19:01:02.120Z",
    durationMs: 2692,
    model: "example-model",
    usage: { inputTokens: 412, outputTokens: 96, totalTokens: 508 },
    costUsd: 0.0012,
    spanCount: 5,
  };
  const keys = { model: encodeKey("example-model"), name: encodeKey("answer-question") };

  it("describe one trace, skipping zero increments", () => {
    const deltas = traceStatsDeltas(trace, keys);
    const at = (path: string) => deltas.find(([p]) => p.join(".") === path)?.[1];
    expect(at("traces")).toBe(1);
    expect(at("errors")).toBe(1);
    expect(at("spans")).toBe(5);
    expect(at("totalTokens")).toBe(508);
    expect(at("costUsd")).toBe(0.0012);
    expect(at("durationMsSum")).toBe(2692);
    expect(at("hours.19.traces")).toBe(1);
    expect(at(`byModel.${keys.model}.costUsd`)).toBe(0.0012);
    expect(at(`byName.${keys.name}.hist.${latencyBucket(2692)}`)).toBe(1);

    const ok = traceStatsDeltas({ ...trace, status: "ok", costUsd: null, usage: {} }, keys);
    expect(ok.some(([p]) => p[0] === "errors")).toBe(false);
    expect(ok.some(([p]) => p[0] === "costUsd")).toBe(false);
    expect(ok.some(([p]) => p[0] === "totalTokens")).toBe(false);
  });

  it("sum input and output tokens when no total is given", () => {
    const deltas = traceStatsDeltas(
      { ...trace, usage: { inputTokens: 10, outputTokens: 5 } },
      keys,
    );
    expect(deltas.find(([p]) => p[0] === "totalTokens")?.[1]).toBe(15);
  });

  it("describe a score by count, sum or label", () => {
    const name = encodeKey("accuracy");
    expect(scoreStatsDeltas({ name: "accuracy", value: 0.8 }, { name, label: null })).toEqual([
      [["scores", name, "count"], 1],
      [["scores", name, "sum"], 0.8],
    ]);
    const label = encodeKey("true");
    expect(scoreStatsDeltas({ name: "helpful", value: true }, { name, label })).toEqual([
      [["scores", name, "count"], 1],
      [["scores", name, "values", label], 1],
    ]);
  });
});

describe("statsIncrements and applyDeltas", () => {
  it("nest increments, sum repeated paths and stamp updatedAt", () => {
    const doc = statsIncrements(
      [
        [["traces"], 1],
        [["traces"], 1],
        [["byName", "abc", "traces"], 1],
      ],
      1,
    );
    expect((doc.traces as FieldValue).isEqual(FieldValue.increment(2))).toBe(true);
    const byName = doc.byName as { abc: { traces: FieldValue } };
    expect(byName.abc.traces.isEqual(FieldValue.increment(1))).toBe(true);
    expect((doc.updatedAt as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);

    const negative = statsIncrements([[["costUsd"], 0.5]], -1);
    expect((negative.costUsd as FieldValue).isEqual(FieldValue.increment(-0.5))).toBe(true);
  });

  it("accumulate plain objects the same way", () => {
    const doc = applyDeltas(
      {},
      [
        [["traces"], 1],
        [["hours", "3", "traces"], 1],
      ],
      1,
    );
    applyDeltas(doc, [[["traces"], 1]], 1);
    applyDeltas(doc, [[["hours", "3", "traces"], 1]], -1);
    expect(doc).toEqual({ traces: 2, hours: { "3": { traces: 0 } } });
  });
});
