import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  IngestErrorBody,
  IngestRequest,
  IngestResponse,
  JsonObject,
  JsonValue,
  SpanEventPayload,
  SpanKind,
  SpanPayload,
  TracePayload,
  TraceStatus,
  Usage,
} from "./types.js";

export type * from "./types.js";
import { FireTraceError } from "./errors.js";
import { FireTraceApi } from "./api.js";

// ---------------------------------------------------------------------------
// Options and errors
// ---------------------------------------------------------------------------

export interface FireTraceOptions {
  /** Deployment URL (https://firetrace.example.com) or the full /api/v1/traces URL. */
  endpoint: string;
  /** Project API key: ft_live_<keyId>_<secret>. */
  apiKey: string;
  /** Per-attempt timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt for network errors, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Called recursively on every value before transmission; return the replacement. */
  redact?: (value: JsonValue, path: string[]) => JsonValue;
  /** Serialized size cap per input/output value. Larger values are truncated and marked. Default 256 KiB. */
  maxContentBytes?: number;
  /** Include error stacks when serializing Error objects. Default false. */
  includeErrorStacks?: boolean;
  /** Throw from end()/record() instead of reporting through onError. Default false. */
  throwOnError?: boolean;
  /** Receives every failure when throwOnError is false. */
  onError?: (error: FireTraceError) => void;
  /** Custom fetch (tests, polyfills). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable clocks for tests. */
  clock?: { now(): number; wall(): Date };
}

export { FireTraceError } from "./errors.js";
export * from "./api.js";

export type SendResult =
  { ok: true; response: IngestResponse } | { ok: false; error: FireTraceError };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

const NON_RETRYABLE = new Set([400, 401, 403, 404, 409, 413]);

/** Error -> JSON-safe attributes. Stacks are excluded unless opted in. */
export function serializeError(error: unknown, includeStack = false): JsonObject {
  if (error instanceof Error) {
    const out: JsonObject = { "error.type": error.name, "error.message": error.message };
    if (includeStack && error.stack) out["error.stack"] = error.stack;
    return out;
  }
  return { "error.type": typeof error, "error.message": safeString(error) };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

/** Convert arbitrary values to JSON (drops undefined, functions, symbols; tolerates cycles). */
export function toJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v, seen));
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return toJsonValue((value as { toJSON: () => unknown }).toJSON(), seen);
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    out[k] = toJsonValue(v, seen);
  }
  return out;
}

export function applyRedaction(
  value: JsonValue,
  redact: ((value: JsonValue, path: string[]) => JsonValue) | undefined,
  path: string[] = [],
): JsonValue {
  if (!redact) return value;
  const replaced = redact(value, path);
  if (Array.isArray(replaced))
    return replaced.map((v, i) => applyRedaction(v, redact, [...path, String(i)]));
  if (replaced !== null && typeof replaced === "object") {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(replaced)) out[k] = applyRedaction(v, redact, [...path, k]);
    return out;
  }
  return replaced;
}

function byteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Truncate an oversize value to a marked string. Returns [value, truncated]. Byte-accurate. */
export function limitContent(
  value: JsonValue | undefined,
  maxBytes: number,
): [JsonValue | undefined, boolean] {
  if (value === undefined) return [undefined, false];
  const size = byteLength(value);
  if (size <= maxBytes) return [value, false];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const marker = `… [truncated by FireTrace SDK: ${size} bytes > ${maxBytes} byte limit]`;
  const keep = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  // Slice by UTF-8 bytes, then drop any partial trailing code point, so the
  // result never exceeds maxBytes even for multi-byte content.
  const head = Buffer.from(text, "utf8").subarray(0, keep).toString("utf8").replace(/�+$/, "");
  return [`${head}${marker}`, true];
}

const NAME_MAX = 500;
const IDENTIFIER_MAX = 200;
const TAG_MAX = 64;
const TAGS_MAX = 20;

/** Names must be 1-500 characters on the wire. */
export function clampName(value: string, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return (trimmed || fallback).slice(0, NAME_MAX);
}

/** provider/model/sessionId/userId: 1-200 characters or omitted. */
export function clampIdentifier(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, IDENTIFIER_MAX);
  return trimmed || undefined;
}

export function clampTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim().slice(0, TAG_MAX);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

const USAGE_ALIASES: Record<string, keyof Usage> = {
  inputTokens: "inputTokens",
  input_tokens: "inputTokens",
  promptTokens: "inputTokens",
  prompt_tokens: "inputTokens",
  outputTokens: "outputTokens",
  output_tokens: "outputTokens",
  completionTokens: "outputTokens",
  completion_tokens: "outputTokens",
  totalTokens: "totalTokens",
  total_tokens: "totalTokens",
};

/**
 * Accept provider-shaped usage objects (OpenAI/Anthropic/AI SDK naming) and
 * keep only the three non-negative integer fields the server allows.
 */
export function sanitizeUsage(usage: unknown): Usage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const out: Usage = {};
  for (const [key, raw] of Object.entries(usage as Record<string, unknown>)) {
    const target = USAGE_ALIASES[key];
    if (!target || out[target] !== undefined) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    out[target] = Math.round(n);
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeCost(cost: unknown): number | undefined {
  const n = typeof cost === "number" ? cost : Number(cost);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(5_000, 300 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface StartTraceOptions {
  id?: string;
  status?: TraceStatus;
  provider?: string;
  model?: string;
  sessionId?: string;
  userId?: string;
  tags?: string[];
  input?: unknown;
  metadata?: Record<string, unknown>;
}

export interface EndTraceOptions {
  status?: TraceStatus;
  output?: unknown;
  error?: unknown;
  usage?: Usage;
  costUsd?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StartSpanOptions {
  id?: string;
  kind?: SpanKind;
  provider?: string;
  model?: string;
  input?: unknown;
  attributes?: Record<string, unknown>;
}

export interface EndSpanOptions {
  status?: TraceStatus;
  output?: unknown;
  error?: unknown;
  usage?: Usage;
  costUsd?: number;
  attributes?: Record<string, unknown>;
}

export class FireTrace {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly redact?: FireTraceOptions["redact"];
  private readonly maxContentBytes: number;
  private readonly includeErrorStacks: boolean;
  private readonly throwOnError: boolean;
  private readonly onError?: FireTraceOptions["onError"];
  private readonly fetchImpl: typeof fetch;
  readonly clock: { now(): number; wall(): Date };
  private readonly inFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: FireTraceOptions) {
    if (!options.endpoint)
      throw new FireTraceError("FireTrace: endpoint is required", { code: "config" });
    if (!options.apiKey)
      throw new FireTraceError("FireTrace: apiKey is required", { code: "config" });
    const trimmed = options.endpoint.replace(/\/+$/, "");
    this.url = trimmed.endsWith("/api/v1/traces") ? trimmed : `${trimmed}/api/v1/traces`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.redact = options.redact;
    this.maxContentBytes = options.maxContentBytes ?? 256 * 1024;
    this.includeErrorStacks = options.includeErrorStacks ?? false;
    this.throwOnError = options.throwOnError ?? false;
    this.onError = options.onError;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? { now: () => performance.now(), wall: () => new Date() };
  }

  startTrace(name: string, options: StartTraceOptions = {}): Trace {
    return new Trace(this, name, options);
  }

  /** Send a fully built trace payload. */
  async record(trace: TracePayload): Promise<SendResult> {
    const body: IngestRequest = { schemaVersion: 1, trace };
    const promise = this.send(body);
    this.inFlight.add(promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(promise);
    }
  }

  /**
   * Read/delete client for the same deployment and key (scopes traces:read /
   * traces:delete). See docs/api.md.
   */
  api(): FireTraceApi {
    return new FireTraceApi({
      endpoint: this.url.replace(/\/api\/v1\/traces$/, ""),
      apiKey: this.apiKey,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Resolve once every in-flight send has settled. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** Flush, then refuse further sends. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /** @internal */
  prepareContent(value: unknown, path: string[]): [JsonValue | undefined, boolean] {
    if (value === undefined) return [undefined, false];
    const json = applyRedaction(toJsonValue(value), this.redact, path);
    return limitContent(json, this.maxContentBytes);
  }

  /** @internal */
  prepareObject(value: Record<string, unknown> | undefined, path: string[]): JsonObject {
    if (!value) return {};
    const json = applyRedaction(toJsonValue(value), this.redact, path);
    return json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  }

  /** @internal */
  errorAttributes(error: unknown): JsonObject {
    return serializeError(error, this.includeErrorStacks);
  }

  /** @internal */
  report(error: FireTraceError): SendResult {
    if (this.throwOnError) throw error;
    try {
      this.onError?.(error);
    } catch {
      // never let a reporting hook break the host application
    }
    return { ok: false, error };
  }

  private async send(body: IngestRequest): Promise<SendResult> {
    if (this.closed) {
      return this.report(new FireTraceError("FireTrace client is shut down", { code: "closed" }));
    }
    const payload = JSON.stringify(body);
    let lastError: FireTraceError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        if (res.ok) {
          const json = (await res.json()) as IngestResponse;
          return { ok: true, response: json };
        }
        let parsed: IngestErrorBody | null = null;
        try {
          parsed = (await res.json()) as IngestErrorBody;
        } catch {
          parsed = null;
        }
        const retryable =
          !NON_RETRYABLE.has(res.status) && (res.status === 429 || res.status >= 500);
        lastError = new FireTraceError(
          parsed?.error?.message ?? `FireTrace ingest failed with HTTP ${res.status}`,
          {
            status: res.status,
            code: parsed?.error?.code ?? `http_${res.status}`,
            requestId: parsed?.error?.requestId ?? res.headers.get("x-request-id"),
            retryable,
          },
        );
        if (!retryable) break;
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        lastError = new FireTraceError(
          aborted
            ? `FireTrace request timed out after ${this.timeoutMs} ms`
            : `FireTrace network error: ${safeString(err instanceof Error ? err.message : err)}`,
          {
            code: aborted ? "timeout" : "network",
            retryable: true,
            cause: err,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return this.report(
      lastError ?? new FireTraceError("FireTrace ingest failed", { code: "unknown" }),
    );
  }
}

// ---------------------------------------------------------------------------
// Trace and Span builders
// ---------------------------------------------------------------------------

export class Span {
  readonly id: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  private readonly kind: SpanKind;
  private readonly startedWall: Date;
  private readonly startedMono: number;
  private endedAt: string | null = null;
  private status: TraceStatus = "unset";
  private provider?: string;
  private model?: string;
  private input?: unknown;
  private output?: unknown;
  private usage?: Usage;
  private costUsd?: number;
  private attributes: Record<string, unknown>;
  private readonly events: SpanEventPayload[] = [];
  private readonly truncated: string[] = [];

  /** @internal */
  constructor(
    private readonly trace: Trace,
    name: string,
    parentSpanId: string | null,
    options: StartSpanOptions,
  ) {
    this.id = options.id ?? generateSpanId();
    this.parentSpanId = parentSpanId;
    this.name = name;
    this.kind = options.kind ?? "custom";
    this.provider = options.provider;
    this.model = options.model;
    this.input = options.input;
    this.attributes = { ...(options.attributes ?? {}) };
    this.startedWall = trace.client.clock.wall();
    this.startedMono = trace.client.clock.now();
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    return this.trace.createSpan(name, this.id, options);
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    if (this.events.length >= 50) return this;
    const offset = this.trace.client.clock.now() - this.startedMono;
    let prepared: JsonObject | undefined;
    if (attributes) {
      try {
        prepared = this.trace.client.prepareObject(attributes, ["spans", this.id, "events", name]);
      } catch (err) {
        prepared = {
          "firetrace.error": `event attributes could not be serialized: ${safeString(err instanceof Error ? err.message : err)}`,
        };
      }
    }
    this.events.push({
      name: clampName(name, "event"),
      timestamp: new Date(this.startedWall.getTime() + offset).toISOString(),
      ...(prepared ? { attributes: prepared } : {}),
    });
    return this;
  }

  setAttributes(attributes: Record<string, unknown>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  end(options: EndSpanOptions = {}): void {
    if (this.endedAt) return;
    const elapsed = Math.max(0, this.trace.client.clock.now() - this.startedMono);
    this.endedAt = new Date(this.startedWall.getTime() + elapsed).toISOString();
    if (options.error !== undefined) {
      Object.assign(this.attributes, this.trace.client.errorAttributes(options.error));
      this.status = options.status ?? "error";
    } else if (options.status) {
      this.status = options.status;
    }
    if (options.output !== undefined) this.output = options.output;
    if (options.usage) this.usage = sanitizeUsage(options.usage);
    if (options.costUsd !== undefined) this.costUsd = sanitizeCost(options.costUsd);
    if (options.attributes) Object.assign(this.attributes, options.attributes);
  }

  /** @internal */
  toPayload(): SpanPayload {
    const client = this.trace.client;
    const end =
      this.endedAt ??
      new Date(
        this.startedWall.getTime() + Math.max(0, client.clock.now() - this.startedMono),
      ).toISOString();
    const [input, inputTruncated] = client.prepareContent(this.input, ["spans", this.id, "input"]);
    const [output, outputTruncated] = client.prepareContent(this.output, [
      "spans",
      this.id,
      "output",
    ]);
    if (inputTruncated) this.truncated.push("input");
    if (outputTruncated) this.truncated.push("output");
    const attributes = client.prepareObject(this.attributes, ["spans", this.id, "attributes"]);
    if (this.truncated.length) attributes["firetrace.truncated"] = [...new Set(this.truncated)];
    const payload: SpanPayload = {
      id: this.id,
      parentSpanId: this.parentSpanId,
      name: clampName(this.name, "span"),
      kind: this.kind,
      status: this.status,
      startedAt: this.startedWall.toISOString(),
      endedAt: end,
      attributes,
      events: this.events,
    };
    const provider = clampIdentifier(this.provider);
    const model = clampIdentifier(this.model);
    if (provider) payload.provider = provider;
    if (model) payload.model = model;
    if (input !== undefined) payload.input = input;
    if (output !== undefined) payload.output = output;
    if (this.usage) payload.usage = this.usage;
    if (this.costUsd !== undefined) payload.costUsd = this.costUsd;
    return payload;
  }
}

export class Trace {
  readonly id: string;
  readonly name: string;
  private readonly startedWall: Date;
  private readonly startedMono: number;
  private readonly spans: Span[] = [];
  private status: TraceStatus;
  private provider?: string;
  private model?: string;
  private sessionId?: string;
  private userId?: string;
  private tags: string[];
  private input?: unknown;
  private output?: unknown;
  private metadata: Record<string, unknown>;
  private usage: Usage = {};
  private costUsd?: number;
  private ended = false;

  /** @internal */
  constructor(
    readonly client: FireTrace,
    name: string,
    options: StartTraceOptions,
  ) {
    this.id = options.id ?? generateTraceId();
    this.name = name;
    this.status = options.status ?? "unset";
    this.provider = options.provider;
    this.model = options.model;
    this.sessionId = options.sessionId;
    this.userId = options.userId;
    this.tags = [...(options.tags ?? [])];
    this.input = options.input;
    this.metadata = { ...(options.metadata ?? {}) };
    this.startedWall = client.clock.wall();
    this.startedMono = client.clock.now();
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    return this.createSpan(name, null, options);
  }

  /** @internal */
  createSpan(name: string, parentSpanId: string | null, options: StartSpanOptions): Span {
    const span = new Span(this, name, parentSpanId, options);
    this.spans.push(span);
    return span;
  }

  setMetadata(metadata: Record<string, unknown>): this {
    Object.assign(this.metadata, metadata);
    return this;
  }

  /** Build the wire payload without sending it. */
  toPayload(): TracePayload {
    const elapsed = Math.max(0, this.client.clock.now() - this.startedMono);
    const endedAt = new Date(this.startedWall.getTime() + elapsed).toISOString();
    const [input, inputTruncated] = this.client.prepareContent(this.input, ["input"]);
    const [output, outputTruncated] = this.client.prepareContent(this.output, ["output"]);
    const metadata = this.client.prepareObject(this.metadata, ["metadata"]);
    const truncated = [inputTruncated ? "input" : null, outputTruncated ? "output" : null].filter(
      Boolean,
    ) as string[];
    if (truncated.length) metadata["firetrace.truncated"] = truncated;
    const payload: TracePayload = {
      id: this.id,
      name: clampName(this.name, "trace"),
      status: this.status,
      startedAt: this.startedWall.toISOString(),
      endedAt,
      tags: clampTags(this.tags),
      metadata,
      usage: this.usage,
      spans: this.spans.slice(0, 200).map((s) => s.toPayload()),
    };
    const provider = clampIdentifier(this.provider);
    const model = clampIdentifier(this.model);
    const sessionId = clampIdentifier(this.sessionId);
    const userId = clampIdentifier(this.userId);
    if (provider) payload.provider = provider;
    if (model) payload.model = model;
    if (sessionId) payload.sessionId = sessionId;
    if (userId) payload.userId = userId;
    if (input !== undefined) payload.input = input;
    if (output !== undefined) payload.output = output;
    if (this.costUsd !== undefined) payload.costUsd = this.costUsd;
    return payload;
  }

  /** End the trace, close any open spans, and send it. Never throws unless throwOnError. */
  async end(options: EndTraceOptions = {}): Promise<SendResult> {
    if (this.ended) {
      return this.client.report(
        new FireTraceError(`Trace ${this.id} was already ended`, { code: "already_ended" }),
      );
    }
    this.ended = true;
    if (options.error !== undefined) {
      Object.assign(this.metadata, this.client.errorAttributes(options.error));
      this.status = options.status ?? "error";
    } else if (options.status) {
      this.status = options.status;
    }
    if (options.output !== undefined) this.output = options.output;
    if (options.usage) this.usage = sanitizeUsage(options.usage) ?? {};
    if (options.costUsd !== undefined) this.costUsd = sanitizeCost(options.costUsd);
    if (options.metadata) Object.assign(this.metadata, options.metadata);
    if (options.tags) this.tags.push(...options.tags);
    for (const span of this.spans) span.end();
    let payload: TracePayload;
    try {
      payload = this.toPayload();
    } catch (err) {
      // A throwing redact hook, toJSON, or getter must never break the host app.
      return this.client.report(
        new FireTraceError(
          `FireTrace could not serialize trace ${this.id}: ${safeString(err instanceof Error ? err.message : err)}`,
          { code: "serialize", cause: err },
        ),
      );
    }
    return this.client.record(payload);
  }
}
