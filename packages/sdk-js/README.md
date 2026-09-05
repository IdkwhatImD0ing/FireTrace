# @firetrace/sdk

A small Node.js client for recording completed LLM and agent traces to a self-deployed [FireTrace](../../README.md) instance. It builds the wire payload for `POST /api/v1/traces`, sends it once the trace ends, retries transient failures, and never throws into your application unless you ask it to.

- Node.js 22 or newer; ESM only (`"type": "module"`). Uses `node:crypto`, `node:perf_hooks`, and the global `fetch`, so it does not run in browsers or Edge runtimes.
- No runtime dependencies.
- Types mirror the server schema in `src/lib/firetrace/schema.ts` (`packages/sdk-js/src/types.ts`).

## Install

The package is not published to npm yet.

**Inside this repository** it is already wired up as a workspace package (`"@firetrace/sdk": "workspace:*"` in the root `package.json`), and `import { FireTrace } from "@firetrace/sdk"` resolves to `packages/sdk-js/src/index.ts`. `scripts/send-example-trace.ts` is a complete example.

**In another project**, build and pack a tarball from your clone, then install it:

```bash
# in the FireTrace clone
pnpm install
pnpm sdk:build                       # compiles packages/sdk-js/src -> dist/
cd packages/sdk-js && pnpm pack      # writes firetrace-sdk-0.2.0.tgz (manifest points at dist/)

# in your project
pnpm add /path/to/firetrace-sdk-0.2.0.tgz
```

`pnpm pack` applies the `publishConfig` in `packages/sdk-js/package.json`, so the tarball's entry points are the compiled `dist/index.js` and `dist/index.d.ts`. Installing the directory itself (`pnpm add /path/to/packages/sdk-js`) instead resolves to the TypeScript source and needs a TypeScript-aware loader such as `tsx`.

## Usage

```ts
import { FireTrace } from "@firetrace/sdk";

const client = new FireTrace({
  endpoint: process.env.FIRETRACE_ENDPOINT!, // "https://your-deployment.example" or ".../api/v1/traces"
  apiKey: process.env.FIRETRACE_API_KEY!, // "ft_live_<keyId>_<secret>"
  onError: (err) => console.warn("firetrace:", err.code, err.message),
});

const trace = client.startTrace("answer-question", {
  sessionId: "session-123",
  userId: "user-456",
  tags: ["chat"],
  provider: "example-provider",
  model: "example-model",
  input: { prompt },
  metadata: { route: "/api/chat" },
});

const agent = trace.startSpan("answer-question", { kind: "agent" });
agent.addEvent("plan.ready", { steps: 2 });

const tool = agent.startSpan("lookup", { kind: "tool", input: { url } });
tool.end({ status: "ok", output: { status: 200 } });

const llm = agent.startSpan("generate-text", {
  kind: "llm",
  provider: "example-provider",
  model: "example-model",
  input: { messages },
});

try {
  const result = await callModel();
  llm.end({
    status: "ok",
    output: { text: result.text },
    usage: result.usage,
    costUsd: result.cost,
  });
  agent.end({ status: "ok" });
  const sent = await trace.end({
    status: "ok",
    output: { text: result.text },
    usage: result.usage,
  });
  if (sent.ok) console.log(sent.response.traceId, sent.response.duplicate);
} catch (error) {
  llm.end({ status: "error", error });
  agent.end({ status: "error" });
  await trace.end({ status: "error", error });
  throw error;
}

// Before the process exits (serverless handlers, CLI scripts):
await client.shutdown();
```

`trace.end()` closes any spans that are still open, builds the payload, and sends it. It returns a `SendResult`: `{ ok: true, response }` with the server's `{ ok, traceId, projectId, spanCount, duplicate, requestId }`, or `{ ok: false, error }` with a `FireTraceError`. Calling `end()` twice on the same trace reports an `already_ended` error.

## Options

`new FireTrace(options)`

| Option               | Type                                   | Default                        | Description                                                                                                                                    |
| -------------------- | -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`           | `string`                               | required                       | Deployment origin or the full `/api/v1/traces` URL. Trailing slashes are removed and the path is appended when missing.                        |
| `apiKey`             | `string`                               | required                       | Project API key from the FireTrace settings page. Sent as `Authorization: Bearer`.                                                             |
| `timeoutMs`          | `number`                               | `10000`                        | Per-attempt timeout, enforced with `AbortController`.                                                                                          |
| `maxRetries`         | `number`                               | `2`                            | Retries after the first attempt for retryable failures (below).                                                                                |
| `redact`             | `(value, path: string[]) => JsonValue` | none                           | Called on every value, parents before children, for `input`, `output`, `metadata`, `attributes`, and event attributes. Return the replacement. |
| `maxContentBytes`    | `number`                               | `262144` (256 KiB)             | Serialized size cap per `input` and per `output` value (trace and span). Larger values are replaced by a marked string.                        |
| `includeErrorStacks` | `boolean`                              | `false`                        | Include `error.stack` when serializing `Error` objects passed as `error`.                                                                      |
| `throwOnError`       | `boolean`                              | `false`                        | Throw `FireTraceError` from `end()` / `record()` instead of returning `{ ok: false }`. Useful in development.                                  |
| `onError`            | `(error: FireTraceError) => void`      | none                           | Receives every failure when `throwOnError` is false. Exceptions thrown by the hook are swallowed.                                              |
| `fetch`              | `typeof fetch`                         | `globalThis.fetch`             | Custom fetch for tests or proxies.                                                                                                             |
| `clock`              | `{ now(): number; wall(): Date }`      | `performance.now` / `new Date` | Injectable clocks for deterministic tests.                                                                                                     |

### Trace and span methods

| Method                             | Notes                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.startTrace(name, opts)`    | `opts`: `id`, `status`, `provider`, `model`, `sessionId`, `userId`, `tags`, `input`, `metadata`. Generates a 32-hex trace id when `id` is omitted. |
| `trace.startSpan(name, opts)`      | Root span. `opts`: `id`, `kind` (default `"custom"`), `provider`, `model`, `input`, `attributes`.                                                  |
| `span.startSpan(name, opts)`       | Child span with `parentSpanId` set to the parent.                                                                                                  |
| `span.addEvent(name, attributes?)` | Timestamped event; silently ignored after 50 events on that span.                                                                                  |
| `span.setAttributes(attributes)`   | Merge attributes.                                                                                                                                  |
| `span.end(opts)`                   | `opts`: `status`, `output`, `error`, `usage`, `costUsd`, `attributes`. Idempotent; the first call fixes `endedAt`.                                 |
| `trace.setMetadata(metadata)`      | Merge metadata.                                                                                                                                    |
| `trace.toPayload()`                | Build the wire payload without sending (for inspection or manual `client.record()`).                                                               |
| `trace.end(opts)`                  | `opts`: `status`, `output`, `error`, `usage`, `costUsd`, `metadata`, `tags`. Ends open spans and sends.                                            |
| `client.record(payload)`           | Send a hand-built `TracePayload` (`{ schemaVersion: 1, trace }` is added).                                                                         |
| `client.flush()`                   | Resolve once all in-flight sends have settled.                                                                                                     |
| `client.shutdown()`                | `flush()`, then refuse further sends (they report a `closed` error).                                                                               |

Exported helpers: `generateTraceId()`, `generateSpanId()`, `serializeError(error, includeStack?)`, `toJsonValue(value)`, `applyRedaction(value, redact)`, `limitContent(value, maxBytes)`, and the `FireTraceError` class with `status`, `code`, `requestId`, and `retryable` properties.

## Timing

Each trace and span records the wall-clock time at start (`Date`) and measures elapsed time with the monotonic clock (`performance.now()`), so `endedAt` is `startedAt + elapsed` and is never affected by clock adjustments. `trace.end()` uses the same moment for any span that was never ended explicitly. Timestamps are serialized as UTC ISO 8601 strings.

## Errors and statuses

Passing `error` to `span.end()` or `trace.end()`:

- serializes it with `serializeError`: `error.type` (the `Error` name, or `typeof` for non-errors) and `error.message`, plus `error.stack` only when `includeErrorStacks: true`;
- writes those keys into the span's `attributes` (or the trace's `metadata`);
- sets `status` to `"error"` unless you passed an explicit `status`.

The FireTrace dashboard's Error tab reads `error.type`, `error.message`, and `error.stack` from span attributes, so errors recorded this way are shown without extra work. Stacks are excluded by default because they can contain file paths and, in some frameworks, secrets.

## Content conversion, redaction, and truncation

Before transmission every `input`, `output`, `metadata`, `attributes`, and event `attributes` value goes through three steps, in this order:

1. **JSON conversion** (`toJsonValue`): `undefined` and `null` become `null`; non-finite numbers and `bigint` become strings; `Date` becomes an ISO string; `Error` becomes the error attributes above; objects with `toJSON` are honored; `undefined`, function, and symbol properties are dropped; circular references become `"[Circular]"`.
2. **Redaction** (`redact` option): called with each value and its path (for example `["spans", "<spanId>", "input", "messages", "0", "content"]` or `["metadata", "apiKey"]`), parents first, then recursively on whatever you return. Return the value unchanged to keep it, or a replacement such as `"[redacted]"`.
3. **Truncation** (`maxContentBytes`, `input` and `output` only): a value whose serialized size exceeds the cap is replaced by a string of the form `<prefix>… [truncated by FireTrace SDK: <size> bytes > <limit> byte limit]`, and `firetrace.truncated: ["input" | "output"]` is added to the span's `attributes` (or the trace's `metadata`) so truncation is visible in the dashboard. `attributes` and `metadata` are not truncated; keep them small.

The SDK also trims to the server limits silently so a run is never lost to a validation error: names are trimmed to 500 characters (an empty name becomes `trace`, `span`, or `event`), `provider`/`model`/`sessionId`/`userId` to 200 characters, at most 20 unique non-empty tags of 64 characters, and at most the first 200 spans. `usage` accepts provider-shaped objects (`inputTokens`/`promptTokens`/`prompt_tokens`, `outputTokens`/`completionTokens`/`completion_tokens`, `totalTokens`/`total_tokens`); other keys are dropped and values are rounded to non-negative integers, and a negative or non-finite `costUsd` is dropped. If the redaction hook, a `toJSON`, or a getter throws while a trace is being serialized, `trace.end()` reports a `serialize` `FireTraceError` through `onError` (or throws it with `throwOnError`) instead of letting the exception escape into the host application. Everything else is validated by the server (see `docs/ingestion-api.md`); a rejected payload comes back as a non-retryable `FireTraceError` with the server's `code` and `message`.

## Retries and failure handling

A send makes up to `1 + maxRetries` attempts (three by default).

- **Retried**: network errors, per-attempt timeouts, HTTP `429`, and HTTP `5xx`.
- **Never retried**: `400`, `401`, `403`, `404`, `409`, `413`, and any other `4xx`.
- **Backoff** before retry `k` (1-based): base `min(5000, 300 · 2^(k−1))` ms with jitter between half and the full base, so roughly 150–300 ms, then 300–600 ms with the defaults.

When every attempt fails, the result depends on `throwOnError`: `false` (default) calls `onError` and returns `{ ok: false, error }`; `true` throws the `FireTraceError`. `error.code` is the server's error code (`invalid_api_key`, `trace_id_conflict`, `payload_too_large`, `quota_exhausted`, ...), `http_<status>` when the body could not be parsed, or one of the SDK's own codes: `config`, `closed`, `already_ended`, `timeout`, `network`, `unknown`. `error.requestId` carries the server's request id when available.

`trace.end()` returns a promise that settles when the send (including retries) has finished. If you choose not to await it, call `client.flush()` or `client.shutdown()` before the process exits, or the trace may be lost.

## curl fallback

Any language can send the same payload directly. The full reference is in `docs/ingestion-api.md`.

```bash
curl -X POST https://your-deployment.example/api/v1/traces \
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 1,
    "trace": {
      "id": "'"$(openssl rand -hex 16)"'",
      "name": "answer-question",
      "status": "ok",
      "startedAt": "2026-09-02T19:01:02.120Z",
      "endedAt": "2026-09-02T19:01:04.812Z",
      "model": "example-model",
      "spans": [
        { "id": "00f067aa0ba902b7", "parentSpanId": null, "name": "answer-question", "kind": "agent",
          "status": "ok", "startedAt": "2026-09-02T19:01:02.120Z", "endedAt": "2026-09-02T19:01:04.812Z" },
        { "id": "b7ad6b7169203331", "parentSpanId": "00f067aa0ba902b7", "name": "generate-text", "kind": "llm",
          "status": "ok", "model": "example-model",
          "startedAt": "2026-09-02T19:01:02.350Z", "endedAt": "2026-09-02T19:01:04.600Z",
          "usage": { "inputTokens": 120, "outputTokens": 84, "totalTokens": 204 } }
      ]
    }
  }'
```

Responses: `201` stored, `200` identical duplicate, `400` invalid, `401` bad key, `409` trace id reused with different content, `413` too large, `429` Firestore quota exhausted, `500` server error. Every error body is `{ "error": { "code", "message", "requestId" } }`.

## License

MIT, see [LICENSE](../../LICENSE).

## Reading, annotating, and deleting traces

`FireTraceApi` wraps the key-authenticated side of the API beyond ingestion ([docs/api.md](../../docs/api.md)). It needs a key with the `traces:read` scope (`traces:write` for `addScore` and `patchMetadata`, `traces:delete` for `deleteTrace` and `deleteScore`); the recording client's default keys have `traces:write` + `traces:read`.

```ts
import { FireTrace, FireTraceApi } from "@firetrace/sdk";

const api = new FireTraceApi({
  endpoint: process.env.FIRETRACE_ENDPOINT!,
  apiKey: process.env.FIRETRACE_API_KEY!,
});
// or, from an existing recording client: client.api()

const key = await api.getKey(); // { keyId, projectId, scopes, expiresAt, lastUsedAt, environment }
const page = await api.listTraces({ status: "error", limit: 20 }); // { traces, nextCursor, prevCursor, pageSize }
const slow = await api.listTraces({ name: "answer-question", sort: "slowest" }); // also tag, costliest
const prod = await api.listTraces({ environment: "production", sort: "costliest" }); // or "unassigned"
for await (const trace of api.iterateTraces({ model: "example-model" })) console.log(trace.id);
const detail = await api.getTrace(page.traces[0].id); // { trace, spans, scores } or null
await api.addScore(page.traces[0].id, { name: "helpful", dataType: "boolean", value: true }); // requires traces:write
const scores = await api.listTraceScores(page.traces[0].id); // newest first
const helpful = await api.listScores({ name: "helpful", limit: 100 }); // { scores, nextCursor, pageSize }
await api.patchMetadata(page.traces[0].id, { ticket: "SUP-142" }); // requires traces:write
await api.deleteScore(page.traces[0].id, scores[0].id); // requires traces:delete
await api.deleteTrace(page.traces[0].id); // requires traces:delete
const project = await api.getProject(); // counters, storage estimate, key scopes
```

Unlike `trace.end()`, these methods throw `FireTraceError` (with `status`, `code`, `requestId`) on any non-2xx response; `getTrace` turns a 404 into `null`. There are no automatic retries on this side.

`addScore` attaches a judgement to a stored trace: a rating, a reviewer's verdict, an eval result. A score has a `name` (letters, digits, `_` and `-`), a `dataType` of `numeric`, `categorical`, or `boolean` with a matching `value`, and an optional `comment`. Scores are append-only and indexed: adding a name again records a newer score, every trace summary carries the newest score per name in `scores`, and `listScores({ name })` finds them across the project.

```ts
// Wire a thumbs rating in a chat widget straight to the trace it belongs to.
await api.addScore(traceId, {
  name: "helpful",
  dataType: "boolean",
  value: rating === "up",
  comment: freeTextFeedback,
});
```

`patchMetadata` shallow-merges keys into a stored trace's `metadata`, for free-form facts that only exist after the run. A patched key replaces that top-level key outright, concurrent writers on one key are last-writer-wins, and metadata is not indexed so it cannot be filtered or aggregated server-side. It returns `{ traceId, metadata, changed }`, where `metadata` is the full merged object and `changed` is `false` when the merge matched what was already stored.
