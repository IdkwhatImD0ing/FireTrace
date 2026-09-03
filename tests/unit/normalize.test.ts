import { describe, expect, it } from "vitest";
import { byteLength, normalizeIngestBody } from "@/lib/firetrace/normalize";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { LIMITS, type IngestRequest } from "@/lib/firetrace/schema";

const T0 = "2026-09-02T19:01:02.120Z";
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();
const TRACE_ID = "0123456789abcdef0123456789abcdef";

type Span = IngestRequest["trace"]["spans"][number];

/** Fresh, fully typed copy of the deterministic sample. */
function valid(): IngestRequest {
  return structuredClone(sampleTraceRequest());
}

type LooseBody = {
  schemaVersion: unknown;
  trace: Record<string, unknown> & { spans: Array<Record<string, unknown>> };
};

/** Loosely typed copy for building deliberately invalid bodies. */
function loose(): LooseBody {
  return structuredClone(sampleTraceRequest()) as unknown as LooseBody;
}

function span(
  index: number,
  parentSpanId: string | null = null,
  overrides: Partial<Span> = {},
): Span {
  return {
    id: index.toString(16).padStart(16, "0"),
    parentSpanId,
    name: `span-${index}`,
    kind: "custom",
    status: "ok",
    startedAt: at(0),
    endedAt: at(10),
    attributes: {},
    events: [],
    ...overrides,
  };
}

function minimalTrace(spans: Span[] = []): IngestRequest {
  return {
    schemaVersion: 1,
    trace: {
      id: TRACE_ID,
      name: "minimal",
      status: "unset",
      startedAt: at(0),
      endedAt: at(10),
      tags: [],
      metadata: {},
      usage: {},
      spans,
    },
  };
}

function expectValid(body: unknown) {
  const result = normalizeIngestBody(body);
  if (!result.ok) throw new Error(`expected a valid body, got: ${result.error.message}`);
  return result.value;
}

function expectInvalid(body: unknown, pattern?: RegExp) {
  const result = normalizeIngestBody(body);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an invalid body");
  expect(result.error.code).toBe("invalid_trace");
  if (pattern) expect(result.error.message).toMatch(pattern);
  return result.error;
}

describe("normalizeIngestBody", () => {
  it("accepts the deterministic sample trace", () => {
    const { trace, spans, bodyHash, estimatedBytes } = expectValid(sampleTraceRequest());
    expect(trace.schemaVersion).toBe(1);
    expect(trace.id).toBe("42f38ac8295345a7a12c4e3f60d6da23");
    expect(trace.name).toBe("answer-question");
    expect(trace.status).toBe("ok");
    expect(trace.durationMs).toBe(2692);
    expect(trace.spanCount).toBe(5);
    expect(trace.errorCount).toBe(1);
    expect(trace.tags).toEqual(["sample", "chat"]);
    expect(trace.usage).toEqual({ inputTokens: 412, outputTokens: 96, totalTokens: 508 });
    expect(trace.costUsd).toBe(0.0012);
    expect(trace).not.toHaveProperty("spans");

    expect(spans.map((s) => s.id)).toEqual([
      "00f067aa0ba902b7",
      "3c1f5a9e8b2d4c60",
      "9b7c2e4f1a3d5e60",
      "b7ad6b7169203331",
      "d4e5f6a7b8c9d0e1",
    ]);
    expect(spans.every((s) => s.traceId === trace.id)).toBe(true);
    expect(spans[0].parentSpanId).toBeNull();
    expect(spans[1].parentSpanId).toBe("00f067aa0ba902b7");
    expect(spans[3].status).toBe("error");
    expect(spans[3].durationMs).toBe(550);
    expect(spans[3].events).toHaveLength(2);
    expect(spans[3].events[0]).toEqual({
      name: "retry",
      timestamp: at(1100),
      attributes: { attempt: 1 },
    });

    expect(bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(estimatedBytes).toBe(byteLength(trace) + spans.reduce((n, s) => n + byteLength(s), 0));
    expect(estimatedBytes).toBeGreaterThan(1000);
  });

  it("is deterministic for identical input", () => {
    const a = expectValid(sampleTraceRequest());
    const b = expectValid(sampleTraceRequest());
    expect(a).toEqual(b);
    expect(a.bodyHash).toBe(b.bodyHash);
  });

  it("lowercases uppercase hexadecimal ids and hashes the lowercased form", () => {
    const lower = expectValid(sampleTraceRequest());
    const body = valid();
    body.trace.id = body.trace.id.toUpperCase();
    for (const s of body.trace.spans) {
      s.id = s.id.toUpperCase();
      if (s.parentSpanId) s.parentSpanId = s.parentSpanId.toUpperCase();
    }
    expect(body.trace.id).not.toBe(lower.trace.id);

    const upper = expectValid(body);
    expect(upper.trace.id).toBe(lower.trace.id);
    expect(upper.spans.map((s) => s.id)).toEqual(lower.spans.map((s) => s.id));
    expect(upper.spans.map((s) => s.parentSpanId)).toEqual(lower.spans.map((s) => s.parentSpanId));
    expect(upper.spans.every((s) => s.traceId === lower.trace.id)).toBe(true);
    expect(upper.bodyHash).toBe(lower.bodyHash);
  });

  it("normalizes timestamps to UTC ISO strings and computes durations", () => {
    const body = minimalTrace([
      span(1, null, {
        startedAt: "2026-09-02T19:01:02+02:00",
        endedAt: "2026-09-02T19:01:02.25+02:00",
      }),
    ]);
    body.trace.startedAt = "2026-09-02T19:01:02+02:00";
    body.trace.endedAt = "2026-09-02T19:01:03.5+02:00";
    const { trace, spans } = expectValid(body);
    expect(trace.startedAt).toBe("2026-09-02T17:01:02.000Z");
    expect(trace.endedAt).toBe("2026-09-02T17:01:03.500Z");
    expect(trace.durationMs).toBe(1500);
    expect(spans[0].startedAt).toBe("2026-09-02T17:01:02.000Z");
    expect(spans[0].endedAt).toBe("2026-09-02T17:01:02.250Z");
    expect(spans[0].durationMs).toBe(250);
  });

  it("applies schema defaults and strips absent optional fields", () => {
    const { trace, spans } = expectValid({
      schemaVersion: 1,
      trace: {
        id: TRACE_ID,
        name: "minimal",
        startedAt: at(0),
        endedAt: at(0),
        spans: [{ id: "00000000000000aa", name: "s", startedAt: at(0), endedAt: at(0) }],
      },
    });
    expect(Object.keys(trace).sort()).toEqual(
      [
        "schemaVersion",
        "id",
        "name",
        "status",
        "startedAt",
        "endedAt",
        "durationMs",
        "tags",
        "metadata",
        "usage",
        "spanCount",
        "errorCount",
      ].sort(),
    );
    expect(trace.status).toBe("unset");
    expect(trace.tags).toEqual([]);
    expect(trace.metadata).toEqual({});
    expect(trace.usage).toEqual({});
    expect(trace.durationMs).toBe(0);
    expect(trace.spanCount).toBe(1);
    expect(trace.errorCount).toBe(0);

    expect(spans[0]).toEqual({
      id: "00000000000000aa",
      traceId: TRACE_ID,
      parentSpanId: null,
      name: "s",
      kind: "custom",
      status: "unset",
      startedAt: at(0),
      endedAt: at(0),
      durationMs: 0,
      attributes: {},
      events: [],
    });
  });

  it("allows zero spans", () => {
    const { trace, spans, estimatedBytes } = expectValid(minimalTrace([]));
    expect(spans).toEqual([]);
    expect(trace.spanCount).toBe(0);
    expect(trace.errorCount).toBe(0);
    expect(estimatedBytes).toBe(byteLength(trace));
  });

  it("allows multiple and disconnected root spans", () => {
    const { trace, spans } = expectValid(
      minimalTrace([span(1), span(2), span(3, span(2).id), span(4)]),
    );
    expect(trace.spanCount).toBe(4);
    expect(spans.filter((s) => s.parentSpanId === null)).toHaveLength(3);
    expect(spans[2].parentSpanId).toBe(span(2).id);
  });

  it("counts spans with status error", () => {
    const { trace } = expectValid(
      minimalTrace([
        span(1, null, { status: "error" }),
        span(2, null, { status: "error" }),
        span(3),
      ]),
    );
    expect(trace.errorCount).toBe(2);
    expect(trace.spanCount).toBe(3);
  });

  it("rejects unknown top-level fields", () => {
    expectInvalid({ ...sampleTraceRequest(), extra: true }, /extra/);
  });

  it("rejects unknown trace, span, event, and usage fields", () => {
    const withTraceField = loose();
    withTraceField.trace.unexpected = 1;
    expectInvalid(withTraceField, /unexpected/);

    const withSpanField = loose();
    withSpanField.trace.spans[0].bogus = "x";
    expectInvalid(withSpanField, /bogus/);

    const withEventField = loose();
    withEventField.trace.spans[0].events = [{ name: "e", timestamp: at(1), surprise: 1 }];
    expectInvalid(withEventField, /surprise/);

    const withUsageField = loose();
    withUsageField.trace.usage = { inputTokens: 1, cachedTokens: 2 };
    expectInvalid(withUsageField, /cachedTokens/);
  });

  it("rejects unsupported schema versions and non-object bodies", () => {
    const body = loose();
    body.schemaVersion = 2;
    expectInvalid(body, /schemaVersion/);
    expectInvalid(null);
    expectInvalid("trace");
    expectInvalid([]);
    expectInvalid({ schemaVersion: 1 }, /trace/);
  });

  it("rejects a trace whose endedAt precedes startedAt", () => {
    const body = valid();
    body.trace.endedAt = at(-1);
    expectInvalid(body, /trace\.endedAt cannot precede trace\.startedAt/);
  });

  it("rejects a span whose endedAt precedes startedAt", () => {
    const body = valid();
    body.trace.spans[1].endedAt = at(0); // this span started at +25ms
    expectInvalid(body, /span "3c1f5a9e8b2d4c60": endedAt cannot precede startedAt/);
  });

  it("accepts spans with zero duration", () => {
    expectValid(minimalTrace([span(1, null, { startedAt: at(5), endedAt: at(5) })]));
  });

  it("rejects duplicate span ids", () => {
    const body = valid();
    body.trace.spans[2].id = body.trace.spans[1].id;
    expectInvalid(body, /duplicate span id "3c1f5a9e8b2d4c60"/);
  });

  it("treats span ids as duplicates regardless of case", () => {
    const body = valid();
    body.trace.spans[2].id = body.trace.spans[1].id.toUpperCase();
    expectInvalid(body, /duplicate span id/);
  });

  it("rejects a parent reference to a span that is not in the trace", () => {
    const body = valid();
    body.trace.spans[1].parentSpanId = "ffffffffffffffff";
    expectInvalid(body, /references unknown parentSpanId "ffffffffffffffff"/);
  });

  it("rejects a span that is its own parent", () => {
    expectInvalid(minimalTrace([span(1, span(1).id)]), /cannot be its own parent/);
  });

  it("rejects two-span parent cycles", () => {
    expectInvalid(minimalTrace([span(1, span(2).id), span(2, span(1).id)]), /cycle/);
  });

  it("rejects longer parent cycles even when a root exists", () => {
    const body = minimalTrace([
      span(9),
      span(1, span(3).id),
      span(2, span(1).id),
      span(3, span(2).id),
      span(4, span(9).id),
    ]);
    const error = expectInvalid(body, /form a cycle/);
    expect(error.message).toContain(span(1).id);
  });

  it("rejects malformed ids", () => {
    const shortTrace = loose();
    shortTrace.trace.id = "42f38ac8295345a7a12c4e3f60d6da2";
    expectInvalid(shortTrace, /trace\.id/);

    const nonHexTrace = loose();
    nonHexTrace.trace.id = "42f38ac8295345a7a12c4e3f60d6dazz";
    expectInvalid(nonHexTrace, /trace\.id/);

    const shortSpan = loose();
    shortSpan.trace.spans[0].id = "00f067aa0ba902b";
    expectInvalid(shortSpan, /spans\.0\.id/);

    const badParent = loose();
    badParent.trace.spans[1].parentSpanId = "not-hex";
    expectInvalid(badParent, /spans\.1\.parentSpanId/);
  });

  it(`accepts ${LIMITS.maxSpans} spans and rejects ${LIMITS.maxSpans + 1}`, () => {
    const spans = Array.from({ length: LIMITS.maxSpans }, (_, i) => span(i + 1));
    expect(expectValid(minimalTrace(spans)).trace.spanCount).toBe(LIMITS.maxSpans);
    expectInvalid(minimalTrace([...spans, span(LIMITS.maxSpans + 1)]), /trace\.spans/);
  });

  it(`accepts ${LIMITS.maxEventsPerSpan} events per span and rejects one more`, () => {
    const events = Array.from({ length: LIMITS.maxEventsPerSpan }, (_, i) => ({
      name: `event-${i}`,
      timestamp: at(i),
    }));
    expectValid(minimalTrace([span(1, null, { events })]));
    expectInvalid(
      minimalTrace([
        span(1, null, { events: [...events, { name: "one-too-many", timestamp: at(0) }] }),
      ]),
      /spans\.0\.events/,
    );
  });

  it(`accepts ${LIMITS.maxTags} tags and rejects ${LIMITS.maxTags + 1}`, () => {
    const body = minimalTrace();
    body.trace.tags = Array.from({ length: LIMITS.maxTags }, (_, i) => `tag-${i}`);
    expect(expectValid(body).trace.tags).toHaveLength(LIMITS.maxTags);
    body.trace.tags.push("one-too-many");
    expectInvalid(body, /trace\.tags/);
  });

  it(`accepts a ${LIMITS.maxTagLength}-character tag and rejects a longer or empty one`, () => {
    const body = minimalTrace();
    body.trace.tags = ["t".repeat(LIMITS.maxTagLength)];
    expectValid(body);
    body.trace.tags = ["t".repeat(LIMITS.maxTagLength + 1)];
    expectInvalid(body, /trace\.tags\.0/);
    body.trace.tags = [""];
    expectInvalid(body, /trace\.tags\.0/);
  });

  it("rejects negative or fractional token counts and negative cost", () => {
    const negativeTokens = loose();
    negativeTokens.trace.usage = { inputTokens: -1 };
    expectInvalid(negativeTokens, /trace\.usage\.inputTokens/);

    const fractionalTokens = loose();
    fractionalTokens.trace.spans[1].usage = { outputTokens: 1.5 };
    expectInvalid(fractionalTokens, /spans\.1\.usage\.outputTokens/);

    const negativeCost = loose();
    negativeCost.trace.costUsd = -0.01;
    expectInvalid(negativeCost, /trace\.costUsd/);

    const negativeSpanCost = loose();
    negativeSpanCost.trace.spans[1].costUsd = -1;
    expectInvalid(negativeSpanCost, /spans\.1\.costUsd/);

    const zero = loose();
    zero.trace.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    zero.trace.costUsd = 0;
    expectValid(zero);
  });

  it("rejects invalid timestamps", () => {
    for (const bad of [
      "2026-09-02",
      "2026-09-02 19:01:02Z",
      "2026-09-02T19:01:02",
      "2026-13-01T00:00:00Z",
      "not-a-date",
      1725303662120,
      "",
    ]) {
      const body = loose();
      body.trace.startedAt = bad;
      expectInvalid(body, /trace\.startedAt/);
    }

    const badSpan = loose();
    badSpan.trace.spans[0].endedAt = "yesterday";
    expectInvalid(badSpan, /spans\.0\.endedAt/);

    const badEvent = loose();
    badEvent.trace.spans[0].events = [{ name: "e", timestamp: "2026-99-99T00:00:00Z" }];
    expectInvalid(badEvent, /spans\.0\.events\.0\.timestamp/);
  });

  it("accepts timestamps with and without fractional seconds and with offsets", () => {
    for (const good of [
      "2026-09-02T19:01:02Z",
      "2026-09-02T19:01:02.1Z",
      "2026-09-02T19:01:02.123456Z",
      "2026-09-02T19:01:02+00:00",
      "2026-09-02T19:01:02.120-05:00",
    ]) {
      const body = minimalTrace();
      body.trace.startedAt = good;
      body.trace.endedAt = good;
      const { trace } = expectValid(body);
      expect(trace.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(trace.durationMs).toBe(0);
    }
  });

  it("returns payload_too_large when the trace document exceeds the limit", () => {
    const body = valid();
    body.trace.input = "x".repeat(LIMITS.maxDocumentBytes + 1);
    const result = normalizeIngestBody(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("payload_too_large");
    expect(result.error.message).toMatch(/trace document is \d+ bytes; the limit is 768000 bytes/);
  });

  it("returns payload_too_large when a single span exceeds the limit", () => {
    const body = valid();
    body.trace.spans[3].output = { text: "y".repeat(LIMITS.maxDocumentBytes) };
    const result = normalizeIngestBody(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("payload_too_large");
    expect(result.error.message).toContain('span "b7ad6b7169203331"');
  });

  it("accepts a document just under the limit", () => {
    const body = minimalTrace();
    const overhead = byteLength(expectValid(body).trace) + '"input":"",'.length;
    body.trace.input = "z".repeat(LIMITS.maxDocumentBytes - overhead);
    const { estimatedBytes, trace } = expectValid(body);
    expect(byteLength(trace)).toBeLessThanOrEqual(LIMITS.maxDocumentBytes);
    expect(byteLength(trace)).toBeGreaterThan(LIMITS.maxDocumentBytes - 20);
    expect(estimatedBytes).toBe(byteLength(trace));
  });

  it("hashes independently of key order but differently for different content", () => {
    const base = expectValid(sampleTraceRequest());

    const reordered = loose();
    const trace = reordered.trace;
    reordered.trace = Object.fromEntries(Object.entries(trace).reverse()) as typeof trace;
    reordered.trace.metadata = { region: "local", route: "/api/chat" };
    expect(expectValid(reordered).bodyHash).toBe(base.bodyHash);

    const changed = valid();
    changed.trace.metadata = { ...changed.trace.metadata, region: "remote" };
    expect(expectValid(changed).bodyHash).not.toBe(base.bodyHash);

    const spanChanged = valid();
    spanChanged.trace.spans[1].attributes = { temperature: 0.3 };
    expect(expectValid(spanChanged).bodyHash).not.toBe(base.bodyHash);
  });

  it("estimates bytes from the normalized documents, growing with content", () => {
    const small = expectValid(minimalTrace([span(1)]));
    const large = expectValid(minimalTrace([span(1, null, { input: { text: "a".repeat(1000) } })]));
    expect(large.estimatedBytes).toBeGreaterThan(small.estimatedBytes + 1000);
    expect(large.estimatedBytes).toBe(byteLength(large.trace) + byteLength(large.spans[0]));
  });
});

describe("byteLength", () => {
  it("measures the UTF-8 size of the JSON serialization", () => {
    expect(byteLength("abc")).toBe(5);
    expect(byteLength([])).toBe(2);
    expect(byteLength({ a: "é" })).toBe(10);
    expect(byteLength({ a: 1, b: [true, null] })).toBe('{"a":1,"b":[true,null]}'.length);
  });
});
