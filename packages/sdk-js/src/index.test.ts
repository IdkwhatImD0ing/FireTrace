import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRedaction,
  FireTrace,
  FireTraceError,
  generateSpanId,
  generateTraceId,
  limitContent,
  serializeError,
  toJsonValue,
} from "./index.js";
import type { IngestRequest, IngestResponse, JsonValue, TracePayload } from "./types.js";

const ENDPOINT = "https://firetrace.example.com";
const KEY = `ft_live_${"0".repeat(16)}_${"1".repeat(64)}`;
const TRACE_ID = "42f38ac8295345a7a12c4e3f60d6da23";
const ROOT_ID = "00f067aa0ba902b7";
const CHILD_ID = "b7ad6b7169203331";
const T0 = "2026-09-02T19:01:02.120Z";
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: IngestRequest;
  signal: AbortSignal | null | undefined;
}

type Responder = (call: RecordedCall, attempt: number) => Response | Promise<Response>;

function fakeFetch(respond: Responder) {
  const calls: RecordedCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = {
      url,
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as IngestRequest,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function okBody(traceId: string, duplicate = false): IngestResponse {
  return { ok: true, traceId, projectId: "project-1", spanCount: 0, duplicate, requestId: "req-1" };
}

function errorBody(code: string, message = "failed", requestId = "req-err") {
  return { error: { code, message, requestId } };
}

/** Injected clock: monotonic time and wall time advance together, deterministically. */
function fakeClock() {
  let mono = 1_000;
  const start = Date.parse(T0);
  return {
    clock: { now: () => mono, wall: () => new Date(start + (mono - 1_000)) },
    advance: (ms: number) => {
      mono += ms;
    },
  };
}

function payload(overrides: Partial<TracePayload> = {}): TracePayload {
  return {
    id: TRACE_ID,
    name: "unit",
    status: "ok",
    startedAt: T0,
    endedAt: T0,
    tags: [],
    metadata: {},
    usage: {},
    spans: [],
    ...overrides,
  };
}

function must<T>(value: T | undefined, label = "value"): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Advance fake timers until the fake fetch has been called `expected` times. */
async function advanceUntilCalls(calls: unknown[], expected: number) {
  for (let i = 0; i < 20 && calls.length < expected; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("id generation", () => {
  it("produces 32- and 16-character lowercase hex ids", () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(Array.from({ length: 200 }, generateTraceId)).size).toBe(200);
  });
});

describe("toJsonValue", () => {
  it("passes JSON primitives through and maps undefined to null", () => {
    expect(toJsonValue("s")).toBe("s");
    expect(toJsonValue(1.5)).toBe(1.5);
    expect(toJsonValue(true)).toBe(true);
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue(undefined)).toBeNull();
  });

  it("drops undefined, function, and symbol properties but keeps array slots", () => {
    expect(toJsonValue({ a: undefined, b: 1, c: () => 1, d: Symbol("s"), e: null })).toEqual({
      b: 1,
      e: null,
    });
    expect(toJsonValue([1, undefined, null, "x"])).toEqual([1, null, null, "x"]);
  });

  it("replaces cycles with a marker", () => {
    const obj: { name: string; self?: unknown; list: unknown[] } = { name: "n", list: [] };
    obj.self = obj;
    obj.list.push(obj);
    expect(toJsonValue(obj)).toEqual({ name: "n", list: ["[Circular]"], self: "[Circular]" });
  });

  it("converts Dates, bigints, non-finite numbers, and Errors", () => {
    expect(toJsonValue(new Date(T0))).toBe(T0);
    expect(toJsonValue(BigInt("9007199254740993"))).toBe("9007199254740993");
    expect(toJsonValue(Number.NaN)).toBe("NaN");
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(toJsonValue(new TypeError("bad type"))).toEqual({
      "error.type": "TypeError",
      "error.message": "bad type",
    });
    expect(toJsonValue({ when: new Date(T0), err: new Error("x") })).toEqual({
      when: T0,
      err: { "error.type": "Error", "error.message": "x" },
    });
  });

  it("honors toJSON and stringifies other non-object values", () => {
    expect(toJsonValue({ toJSON: () => ({ x: 1 }) })).toEqual({ x: 1 });
    expect(toJsonValue(Symbol("top"))).toBe("Symbol(top)");
    expect(toJsonValue(new Map([["k", 1]]))).toEqual({});
  });
});

describe("serializeError", () => {
  it("captures type and message without a stack by default", () => {
    const out = serializeError(new RangeError("out of range"));
    expect(out).toEqual({ "error.type": "RangeError", "error.message": "out of range" });
    expect(Object.keys(out)).not.toContain("error.stack");
  });

  it("includes the stack only when asked", () => {
    const out = serializeError(new Error("boom"), true);
    expect(typeof out["error.stack"]).toBe("string");
    expect(String(out["error.stack"])).toContain("boom");
  });

  it("uses custom error class names", () => {
    class QuotaError extends Error {
      override name = "QuotaError";
    }
    expect(serializeError(new QuotaError("full"))["error.type"]).toBe("QuotaError");
  });

  it("describes non-Error values by type", () => {
    expect(serializeError("boom")).toEqual({ "error.type": "string", "error.message": "boom" });
    expect(serializeError({ code: 7 })).toEqual({
      "error.type": "object",
      "error.message": '{"code":7}',
    });
    expect(serializeError(42)).toEqual({ "error.type": "number", "error.message": "42" });
    expect(serializeError(undefined)).toEqual({
      "error.type": "undefined",
      "error.message": "undefined",
    });
    expect(serializeError(null)).toEqual({ "error.type": "object", "error.message": "null" });
  });
});

describe("applyRedaction", () => {
  it("returns the value untouched when no hook is configured", () => {
    const value: JsonValue = { a: [1, { b: "c" }] };
    expect(applyRedaction(value, undefined)).toBe(value);
  });

  it("visits every node with its path and replaces values recursively", () => {
    const seen: string[][] = [];
    const redact = (value: JsonValue, path: string[]): JsonValue => {
      seen.push(path);
      return path[path.length - 1] === "password" && typeof value === "string" ? "***" : value;
    };
    const input: JsonValue = {
      user: { password: "p", list: [{ password: "q" }, "x"] },
      password: "r",
      n: 1,
    };
    const snapshot = structuredClone(input);
    const out = applyRedaction(input, redact);
    expect(out).toEqual({
      user: { password: "***", list: [{ password: "***" }, "x"] },
      password: "***",
      n: 1,
    });
    expect(input).toEqual(snapshot);
    expect(seen).toEqual([
      [],
      ["user"],
      ["user", "password"],
      ["user", "list"],
      ["user", "list", "0"],
      ["user", "list", "0", "password"],
      ["user", "list", "1"],
      ["password"],
      ["n"],
    ]);
  });

  it("stops descending once a subtree has been replaced by a scalar", () => {
    const seen: string[][] = [];
    const out = applyRedaction(
      { user: { secret: "s", nested: { secret: "t" } }, keep: "k" },
      (value, path) => {
        seen.push(path);
        return path.length === 1 && path[0] === "user" ? "[removed]" : value;
      },
    );
    expect(out).toEqual({ user: "[removed]", keep: "k" });
    expect(seen.some((p) => p.length > 1 && p[0] === "user")).toBe(false);
  });

  it("lets the hook replace arrays and objects with new containers", () => {
    const out = applyRedaction([1, 2, 3], (value, path) =>
      path.length === 0 && Array.isArray(value) ? value.slice(0, 1) : value,
    );
    expect(out).toEqual([1]);
  });
});

describe("limitContent", () => {
  it("leaves undefined and small values alone", () => {
    expect(limitContent(undefined, 10)).toEqual([undefined, false]);
    expect(limitContent("short", 100)).toEqual(["short", false]);
    const obj = { a: 1 };
    expect(limitContent(obj, 7)).toEqual([obj, false]);
    expect(limitContent("é", 4)).toEqual(["é", false]);
  });

  it("truncates oversize strings with a marker", () => {
    const [value, truncated] = limitContent("a".repeat(200), 100);
    expect(truncated).toBe(true);
    expect(typeof value).toBe("string");
    const text = String(value);
    expect(text.startsWith(`${"a".repeat(30)}`)).toBe(true);
    expect(text).toContain("… [truncated by FireTrace SDK: 202 bytes > 100 byte limit]");
    // The truncated value itself respects the byte budget.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(100);
  });

  it("truncates oversize objects to a JSON prefix", () => {
    const [value, truncated] = limitContent({ k: "v".repeat(100) }, 80);
    expect(truncated).toBe(true);
    expect(String(value).startsWith(`{"k":"vvv`)).toBe(true);
    expect(String(value)).toContain("108 bytes > 80 byte limit");
    expect(Buffer.byteLength(String(value), "utf8")).toBeLessThanOrEqual(80);
  });

  it("counts multi-byte characters by their UTF-8 size", () => {
    const [value, truncated] = limitContent("é".repeat(100), 120);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(String(value), "utf8")).toBeLessThanOrEqual(120);
    expect(String(value)).not.toContain("�");
  });

  it("keeps nothing but the marker when the limit is tiny", () => {
    const [value, truncated] = limitContent("hello world", 4);
    expect(truncated).toBe(true);
    expect(String(value).startsWith("… [truncated by FireTrace SDK")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe("FireTrace constructor", () => {
  it("requires an endpoint and an api key", () => {
    expect(() => new FireTrace({ endpoint: "", apiKey: KEY })).toThrow(FireTraceError);
    expect(() => new FireTrace({ endpoint: ENDPOINT, apiKey: "" })).toThrowError(
      expect.objectContaining({ code: "config" }),
    );
  });

  it("derives the ingest URL from a deployment URL or a full ingest URL", async () => {
    for (const endpoint of [
      "https://firetrace.example.com",
      "https://firetrace.example.com/",
      "https://firetrace.example.com//",
      "https://firetrace.example.com/api/v1/traces",
      "https://firetrace.example.com/api/v1/traces/",
    ]) {
      const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
      const client = new FireTrace({ endpoint, apiKey: KEY, fetch: fn });
      await client.record(payload());
      expect(must(calls[0]).url).toBe("https://firetrace.example.com/api/v1/traces");
    }
  });
});

describe("FireTrace payload building", () => {
  it("builds a schemaVersion 1 request with nested spans and clock-driven timestamps", async () => {
    const { clock, advance } = fakeClock();
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, clock });

    const trace = client.startTrace("answer-question", {
      id: TRACE_ID,
      provider: "example-provider",
      model: "example-model",
      sessionId: "session-123",
      userId: "user-456",
      tags: ["sample"],
      input: { prompt: "hi", when: new Date(T0) },
      metadata: { route: "/api/chat" },
    });
    advance(10);
    const root = trace.startSpan("agent", { id: ROOT_ID, kind: "agent", input: { step: 1 } });
    advance(5);
    const child = root.startSpan("generate-text", {
      id: CHILD_ID,
      kind: "llm",
      provider: "example-provider",
      model: "example-model",
      attributes: { temperature: 0.2 },
    });
    advance(100);
    child.addEvent("first-token", { index: 0 });
    advance(50);
    child.end({
      status: "ok",
      output: { text: "ok" },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      costUsd: 0.01,
      attributes: { finish: "stop" },
    });
    advance(20);
    root.end({ status: "ok", output: { done: true } });
    advance(15);
    const result = await trace.end({
      status: "ok",
      output: { text: "done" },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      costUsd: 0.02,
      metadata: { extra: true },
      tags: ["chat"],
    });

    expect(result).toEqual({ ok: true, response: okBody(TRACE_ID) });
    expect(calls).toHaveLength(1);
    const call = must(calls[0]);
    expect(call.url).toBe(`${ENDPOINT}/api/v1/traces`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    });
    expect(call.signal).toBeInstanceOf(AbortSignal);

    const body = call.body;
    expect(body.schemaVersion).toBe(1);
    expect(body.trace).toEqual({
      id: TRACE_ID,
      name: "answer-question",
      status: "ok",
      startedAt: at(0),
      endedAt: at(200),
      provider: "example-provider",
      model: "example-model",
      sessionId: "session-123",
      userId: "user-456",
      tags: ["sample", "chat"],
      input: { prompt: "hi", when: T0 },
      output: { text: "done" },
      metadata: { route: "/api/chat", extra: true },
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      costUsd: 0.02,
      spans: [
        {
          id: ROOT_ID,
          parentSpanId: null,
          name: "agent",
          kind: "agent",
          status: "ok",
          startedAt: at(10),
          endedAt: at(185),
          input: { step: 1 },
          output: { done: true },
          attributes: {},
          events: [],
        },
        {
          id: CHILD_ID,
          parentSpanId: ROOT_ID,
          name: "generate-text",
          kind: "llm",
          status: "ok",
          startedAt: at(15),
          endedAt: at(165),
          provider: "example-provider",
          model: "example-model",
          output: { text: "ok" },
          attributes: { temperature: 0.2, finish: "stop" },
          events: [{ name: "first-token", timestamp: at(115), attributes: { index: 0 } }],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          costUsd: 0.01,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("undefined");
  });

  it("closes open spans when the trace ends and defaults status to unset", async () => {
    const { clock, advance } = fakeClock();
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, clock });
    const trace = client.startTrace("t");
    const span = trace.startSpan("open");
    advance(40);
    await trace.end();
    const body = must(calls[0]).body;
    expect(body.trace.status).toBe("unset");
    expect(body.trace.id).toMatch(/^[0-9a-f]{32}$/);
    expect(span.id).toMatch(/^[0-9a-f]{16}$/);
    expect(body.trace.spans).toEqual([
      {
        id: span.id,
        parentSpanId: null,
        name: "open",
        kind: "custom",
        status: "unset",
        startedAt: at(0),
        endedAt: at(40),
        attributes: {},
        events: [],
      },
    ]);
  });

  it("records errors as attributes without stacks by default", async () => {
    const { clock } = fakeClock();
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, clock });
    const trace = client.startTrace("t");
    const span = trace.startSpan("tool", { kind: "tool" });
    span.end({ error: new RangeError("tool exploded") });
    await trace.end({ error: new Error("trace failed") });
    const body = must(calls[0]).body;
    expect(body.trace.status).toBe("error");
    expect(body.trace.metadata).toEqual({ "error.type": "Error", "error.message": "trace failed" });
    expect(must(body.trace.spans[0]).status).toBe("error");
    expect(must(body.trace.spans[0]).attributes).toEqual({
      "error.type": "RangeError",
      "error.message": "tool exploded",
    });
  });

  it("includes error stacks when includeErrorStacks is enabled", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      includeErrorStacks: true,
    });
    await client.startTrace("t").end({ error: new Error("with stack") });
    expect(typeof must(calls[0]).body.trace.metadata["error.stack"]).toBe("string");
  });

  it("applies the redaction hook recursively with span-aware paths", async () => {
    const paths: string[][] = [];
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      redact: (value, path) => {
        paths.push(path);
        return path[path.length - 1] === "secret" ? "[REDACTED]" : value;
      },
    });
    const trace = client.startTrace("t", { input: { secret: "trace-secret", keep: 1 } });
    const span = trace.startSpan("s", {
      id: ROOT_ID,
      input: { nested: { secret: "span-secret" } },
    });
    span.end({ output: { secret: "out" }, attributes: { secret: "attr" } });
    await trace.end({ output: { secret: "trace-out" }, metadata: { secret: "meta" } });

    const body = must(calls[0]).body;
    expect(body.trace.input).toEqual({ secret: "[REDACTED]", keep: 1 });
    expect(body.trace.output).toEqual({ secret: "[REDACTED]" });
    expect(body.trace.metadata).toEqual({ secret: "[REDACTED]" });
    expect(must(body.trace.spans[0]).input).toEqual({ nested: { secret: "[REDACTED]" } });
    expect(must(body.trace.spans[0]).output).toEqual({ secret: "[REDACTED]" });
    expect(must(body.trace.spans[0]).attributes).toEqual({ secret: "[REDACTED]" });
    expect(paths).toContainEqual(["input", "secret"]);
    expect(paths).toContainEqual(["metadata", "secret"]);
    expect(paths).toContainEqual(["spans", ROOT_ID, "input", "nested", "secret"]);
    expect(paths).toContainEqual(["spans", ROOT_ID, "attributes", "secret"]);
    expect(JSON.stringify(body)).not.toMatch(
      /trace-secret|span-secret|"out"|"attr"|"meta"|trace-out/,
    );
  });

  it("truncates oversize content and marks it in metadata and attributes", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      maxContentBytes: 128,
    });
    const trace = client.startTrace("t", { input: "small" });
    const span = trace.startSpan("s", { input: "x".repeat(1000) });
    span.end({ output: { big: "y".repeat(1000) } });
    await trace.end({ output: "z".repeat(1000) });

    const body = must(calls[0]).body;
    expect(body.trace.input).toBe("small");
    expect(String(body.trace.output)).toContain("[truncated by FireTrace SDK");
    expect(body.trace.metadata["firetrace.truncated"]).toEqual(["output"]);
    const spanPayload = must(body.trace.spans[0]);
    expect(String(spanPayload.input)).toContain("[truncated by FireTrace SDK");
    expect(String(spanPayload.output)).toContain("[truncated by FireTrace SDK");
    expect(spanPayload.attributes["firetrace.truncated"]).toEqual(["input", "output"]);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1000);
  });

  it("caps tags at 20 of 64 characters, spans at 200, and events at 50", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn });
    const trace = client.startTrace("t", {
      tags: Array.from({ length: 25 }, (_, i) => `tag-${i}-${"t".repeat(80)}`),
    });
    const span = trace.startSpan("events");
    for (let i = 0; i < 60; i++) span.addEvent(`event-${i}`);
    for (let i = 0; i < 210; i++) trace.startSpan(`span-${i}`);
    await trace.end();
    const body = must(calls[0]).body;
    expect(body.trace.tags).toHaveLength(20);
    expect(body.trace.tags.every((t) => t.length === 64)).toBe(true);
    expect(body.trace.spans).toHaveLength(200);
    expect(must(body.trace.spans[0]).events).toHaveLength(50);
  });

  it("reports a second end() of the same trace without sending again", async () => {
    const onError = vi.fn();
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });
    const trace = client.startTrace("t");
    expect((await trace.end()).ok).toBe(true);
    const again = await trace.end();
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("already_ended");
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("FireTrace transport", () => {
  it("returns the parsed response for a duplicate as well as a new trace", async () => {
    const { fn } = fakeFetch(() => jsonResponse(200, okBody(TRACE_ID, true)));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn });
    const result = await client.record(payload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.duplicate).toBe(true);
    expect(result.response.traceId).toBe(TRACE_ID);
  });

  it("retries twice on 503 and then succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onError = vi.fn();
    const { fn, calls } = fakeFetch((_call, attempt) =>
      attempt < 2
        ? jsonResponse(503, errorBody("internal_error", "try later"))
        : jsonResponse(201, okBody(TRACE_ID)),
    );
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });
    const pending = client.record(payload());
    await advanceUntilCalls(calls, 3);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(onError).not.toHaveBeenCalled();
    expect(calls.every((c) => c.body.trace.id === TRACE_ID)).toBe(true);
  });

  it("gives up after the configured retries and reports the last error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onError = vi.fn();
    const { fn, calls } = fakeFetch(() =>
      jsonResponse(500, errorBody("internal_error", "still broken", "req-500")),
    );
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });
    const pending = client.record(payload());
    await advanceUntilCalls(calls, 3);
    const result = await pending;
    expect(calls).toHaveLength(3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(FireTraceError);
    expect(result.error).toMatchObject({
      status: 500,
      code: "internal_error",
      message: "still broken",
      requestId: "req-500",
      retryable: true,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(result.error);
  });

  it("retries 429 responses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fn, calls } = fakeFetch((_call, attempt) =>
      attempt === 0
        ? jsonResponse(429, errorBody("rate_limited"))
        : jsonResponse(201, okBody(TRACE_ID)),
    );
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, maxRetries: 1 });
    const pending = client.record(payload());
    await advanceUntilCalls(calls, 2);
    expect((await pending).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 413])("does not retry HTTP %i", async (status) => {
    const onError = vi.fn();
    const { fn, calls } = fakeFetch(() =>
      jsonResponse(status, errorBody(`code_${status}`, "nope", "req-x")),
    );
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });
    const result = await client.record(payload());
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      status,
      code: `code_${status}`,
      message: "nope",
      requestId: "req-x",
      retryable: false,
    });
    expect(onError).toHaveBeenCalledWith(result.error);
  });

  it("falls back to generic error details when the body is not JSON", async () => {
    const { fn } = fakeFetch(
      () =>
        new Response("<html>bad gateway</html>", {
          status: 400,
          headers: { "x-request-id": "hdr-1" },
        }),
    );
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn });
    const result = await client.record(payload());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      status: 400,
      code: "http_400",
      message: "FireTrace ingest failed with HTTP 400",
      requestId: "hdr-1",
    });
  });

  it("reports network failures as retryable network errors", async () => {
    const { fn, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, maxRetries: 0 });
    const result = await client.record(payload());
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "network", status: null, retryable: true });
    expect(result.error.message).toContain("fetch failed");
    expect(result.error.cause).toBeInstanceOf(TypeError);
  });

  it("reports through onError without throwing by default, and survives a throwing hook", async () => {
    const onError = vi.fn<(error: FireTraceError) => void>(() => {
      throw new Error("hook exploded");
    });
    const { fn } = fakeFetch(() => jsonResponse(401, errorBody("invalid_api_key")));
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });
    const result = await client.record(payload());
    expect(result.ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(must(onError.mock.calls[0])[0]).toBeInstanceOf(FireTraceError);
  });

  it("throws when throwOnError is enabled", async () => {
    const onError = vi.fn();
    const { fn } = fakeFetch(() => jsonResponse(413, errorBody("payload_too_large", "too big")));
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      throwOnError: true,
      onError,
    });
    const promise = client.record(payload());
    await expect(promise).rejects.toBeInstanceOf(FireTraceError);
    await expect(promise).rejects.toMatchObject({ status: 413, code: "payload_too_large" });
    expect(onError).not.toHaveBeenCalled();
    await expect(client.startTrace("t").end()).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("flush() waits for in-flight sends", async () => {
    const gate = deferred<Response>();
    const { fn, calls } = fakeFetch(() => gate.promise);
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn });

    await client.flush(); // nothing in flight resolves immediately

    const send = client.record(payload());
    let flushed = false;
    const flush = client.flush().then(() => {
      flushed = true;
    });
    await tick();
    await tick();
    expect(calls).toHaveLength(1);
    expect(flushed).toBe(false);

    gate.resolve(jsonResponse(201, okBody(TRACE_ID)));
    await flush;
    expect(flushed).toBe(true);
    await expect(send).resolves.toMatchObject({ ok: true });
  });

  it("flush() resolves even when the in-flight send fails", async () => {
    const gate = deferred<Response>();
    const { fn } = fakeFetch(() => gate.promise);
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      throwOnError: true,
    });
    const send = client.record(payload());
    const flush = client.flush();
    gate.resolve(jsonResponse(400, errorBody("invalid_trace")));
    await expect(send).rejects.toBeInstanceOf(FireTraceError);
    await expect(flush).resolves.toBeUndefined();
  });

  it("shutdown() drains in-flight sends and refuses later ones", async () => {
    const onError = vi.fn();
    const gate = deferred<Response>();
    const { fn, calls } = fakeFetch(() => gate.promise);
    const client = new FireTrace({ endpoint: ENDPOINT, apiKey: KEY, fetch: fn, onError });

    const send = client.record(payload());
    let closed = false;
    const shutdown = client.shutdown().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    gate.resolve(jsonResponse(201, okBody(TRACE_ID)));
    await shutdown;
    expect(closed).toBe(true);
    await expect(send).resolves.toMatchObject({ ok: true });

    const late = await client.record(payload());
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.error.code).toBe("closed");
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(late.error);

    const lateTrace = await client.startTrace("after-shutdown").end();
    expect(lateTrace.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("shutdown() with throwOnError makes later sends throw", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(201, okBody(TRACE_ID)));
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      throwOnError: true,
    });
    await client.shutdown();
    await expect(client.record(payload())).rejects.toMatchObject({ code: "closed" });
    expect(calls).toHaveLength(0);
  });

  it("aborts a request that exceeds timeoutMs", async () => {
    const onError = vi.fn();
    const { fn, calls } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    );
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      timeoutMs: 25,
      maxRetries: 0,
      onError,
    });
    const started = Date.now();
    const result = await client.record(payload());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toHaveLength(1);
    expect(must(calls[0]).signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "timeout", status: null, retryable: true });
    expect(result.error.message).toBe("FireTrace request timed out after 25 ms");
    expect(onError).toHaveBeenCalledWith(result.error);
  });

  it("retries after a timeout with a fresh abort signal", async () => {
    let attempts = 0;
    const { fn, calls } = fakeFetch((call) => {
      attempts++;
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          call.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
      }
      return jsonResponse(201, okBody(TRACE_ID));
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = new FireTrace({
      endpoint: ENDPOINT,
      apiKey: KEY,
      fetch: fn,
      timeoutMs: 20,
      maxRetries: 1,
    });
    const result = await client.record(payload());
    vi.restoreAllMocks();
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(must(calls[0]).signal?.aborted).toBe(true);
    expect(must(calls[1]).signal?.aborted).toBe(false);
    expect(must(calls[0]).signal).not.toBe(must(calls[1]).signal);
  });
});
