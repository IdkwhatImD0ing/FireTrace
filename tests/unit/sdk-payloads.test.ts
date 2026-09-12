import { describe, expect, it } from "vitest";
import { FireTrace } from "@firetrace/sdk";
import {
  normalizeEndBody,
  normalizeIngestBody,
  normalizeSpansBody,
} from "@/lib/firetrace/normalize";

/**
 * What the SDK sends must pass the server's own validators: the Zod schema and
 * the semantic checks in normalize.ts (endedAt >= startedAt, parents present,
 * ...). Nested, finished and open spans, events, and both ways of ending a
 * trace. The clock is injected (CONTRIBUTING.md).
 */

const ENDPOINT = "https://firetrace.test";
const KEY = `ft_live_${"0".repeat(16)}_${"1".repeat(64)}`;

/** Like the default clocks: `wall()` in whole ms, `now()` fractional, on one timeline. */
function steppingClock() {
  let t = Date.parse("2026-09-02T19:01:02.120Z");
  return { now: () => (t += 0.37), wall: () => new Date(Math.floor((t += 0.37))) };
}

function recordingFetch() {
  const sent: Array<{ url: string; body: unknown }> = [];
  const fn: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, sent };
}

function runTrace(client: FireTrace, { explicitEnd }: { explicitEnd: boolean }) {
  const trace = client.startTrace("answer-question", { input: { prompt: "hi" }, tags: ["chat"] });
  const agent = trace.startSpan("agent", { kind: "agent" });
  agent.addEvent("plan.ready", { steps: 2 });
  const llm = agent.startSpan("generate-text", { kind: "llm", model: "example-model" });
  llm.addEvent("first-token");
  llm.end({ status: "ok", output: { text: "ok" }, usage: { inputTokens: 1, outputTokens: 2 } });
  agent.startSpan("still-open", { kind: "tool" });
  const endedAt = explicitEnd ? client.clock.wall() : undefined;
  return { trace, sent: trace.end({ status: "ok", output: { text: "ok" }, endedAt }) };
}

describe("@firetrace/sdk payloads", () => {
  it("sends whole traces the ingest endpoint accepts", async () => {
    const { fn, sent } = recordingFetch();
    const client = new FireTrace({
      streaming: false,
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      clock: steppingClock(),
    });
    for (let i = 0; i < 100; i++) {
      await runTrace(client, { explicitEnd: i % 2 === 1 }).sent;
    }
    expect(sent).toHaveLength(100);
    for (const { body } of sent) {
      const result = normalizeIngestBody(body);
      expect(result.ok ? result.value.spans.length : result.error).toBe(3);
    }
  });

  it("streams a start, span batches and an end the streaming endpoints accept", async () => {
    const { fn, sent } = recordingFetch();
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      clock: steppingClock(),
      maxBatchSpans: 1,
    });
    const { trace, sent: ended } = runTrace(client, { explicitEnd: true });
    await ended;
    // A batch of one per finished span, including the two end() closes, then the end.
    expect(sent.map(({ url }) => url.split("/").pop())).toEqual([
      "traces",
      "spans",
      "spans",
      "spans",
      "end",
    ]);
    const [start, ...rest] = sent;
    const end = rest.pop();

    const started = normalizeIngestBody(start?.body);
    expect(started.ok ? started.value.trace.status : started.error).toBe("running");
    const batched = rest.flatMap(({ body }) => {
      const batch = normalizeSpansBody(body, trace.id);
      return batch.ok ? batch.value.spans.map((s) => s.name) : [batch.error.message];
    });
    expect(batched).toEqual(["generate-text", "agent", "still-open"]);
    const closed = normalizeEndBody(end?.body, trace.id);
    expect(closed.ok ? closed.value.spans : closed.error).toEqual([]);
    // The end transaction's own check, against the stored start.
    if (started.ok && closed.ok) {
      expect(Date.parse(closed.value.endedAt)).toBeGreaterThanOrEqual(
        Date.parse(started.value.trace.startedAt),
      );
    }
  });
});
