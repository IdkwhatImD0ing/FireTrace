# Ingestion API reference

This page covers `POST /api/v1/traces` and `PATCH /api/v1/traces/{traceId}` in depth, plus the single-trace read they pair with. The rest of the key-authenticated API (list, delete, project, key, OpenAPI) is documented in [api.md](./api.md) and the MCP server in [mcp.md](./mcp.md).

FireTrace accepts completed traces over plain HTTPS so any language can integrate. This document is derived from `src/lib/firetrace/schema.ts` (wire schema and limits), `src/lib/firetrace/normalize.ts` (semantic checks and normalization), `src/lib/firetrace/ingest.ts` (authentication and the idempotent transaction), `src/lib/firetrace/metadata.ts` (the metadata patch and its transaction), and the route handlers under `src/app/api/v1/traces/`. When those files change, this document must change with them.

## Endpoint

```http
POST /api/v1/traces
Authorization: Bearer ft_live_<keyId>_<secret>
Content-Type: application/json
```

- One request stores exactly one complete trace with all of its spans. There is no streaming and no batching. Once stored, a trace is immutable apart from its `metadata`, which [`PATCH`](#updating-metadata) can merge into for judgements that only arrive after the run.
- The route runs in the Node.js runtime on the server. It sets `Cache-Control: no-store` and an `X-Request-Id` header on every response and sends no CORS headers; it is intended for server-to-server calls, not browsers.
- `GET /api/v1/traces` returns `405` with code `invalid_request`.

### Authentication

Create keys in the dashboard under **Project settings > API keys**. A key has the form `ft_live_<keyId>_<secret>` where `keyId` is 16 lowercase hex characters and `secret` is 64 lowercase hex characters (32 random bytes). The plaintext is shown once; the server stores only `HMAC-SHA-256(FIRETRACE_KEY_PEPPER, plaintext)` and compares digests in constant time (`src/lib/firetrace/api-keys.ts`).

The `Authorization` header is `Bearer <key>` (scheme matched case-insensitively). A missing header, a malformed key, an unknown key id, a wrong secret, a revoked key, and a key whose project has been deleted all produce the same `401 invalid_api_key` response, so the API never reveals whether a key id exists. Revocation and rotation take effect on the next request.

## Request body

```json
{
  "schemaVersion": 1,
  "trace": { ... }
}
```

Every object in the body is **strict**: unknown keys at any level (request, trace, span, event, usage) are rejected with `400 invalid_trace`. `schemaVersion` must be the number `1`.

The trace's **environment** is deliberately not a body field. It comes from the API key ([api.md](./api.md#environments)): the server copies the key's environment onto the stored trace, and a body that includes `environment` is rejected like any other unknown key. Use one key per environment and a different `FIRETRACE_API_KEY` per deployment scope; the application never needs to know which environment it runs in.

### Trace object

| Field       | Type                                            | Required | Rules                                                                         |
| ----------- | ----------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `id`        | string                                          | yes      | 32 hexadecimal characters. Uppercase is accepted and normalized to lowercase. |
| `name`      | string                                          | yes      | 1–500 characters.                                                             |
| `status`    | `"ok"` \| `"error"` \| `"unset"`                | no       | Default `"unset"`. Not derived from spans.                                    |
| `startedAt` | string                                          | yes      | ISO 8601 timestamp (see below).                                               |
| `endedAt`   | string                                          | yes      | ISO 8601 timestamp; must not precede `startedAt`.                             |
| `provider`  | string                                          | no       | 1–200 characters.                                                             |
| `model`     | string                                          | no       | 1–200 characters. Filterable in the dashboard.                                |
| `sessionId` | string                                          | no       | 1–200 characters. Filterable.                                                 |
| `userId`    | string                                          | no       | 1–200 characters. Filterable.                                                 |
| `tags`      | string[]                                        | no       | Default `[]`. At most 20 tags, each 1–64 characters.                          |
| `input`     | any JSON value                                  | no       | Stored verbatim, displayed, never indexed.                                    |
| `output`    | any JSON value                                  | no       | Stored verbatim, displayed, never indexed.                                    |
| `metadata`  | JSON object                                     | no       | Default `{}`. Displayed, never indexed.                                       |
| `usage`     | `{ inputTokens?, outputTokens?, totalTokens? }` | no       | Default `{}`. Each field a non-negative integer. No other keys.               |
| `costUsd`   | number                                          | no       | Non-negative. Supplied by the caller; FireTrace has no price tables.          |
| `spans`     | Span[]                                          | no       | Default `[]`. At most 200 spans.                                              |

### Span object

| Field          | Type                                                                                                          | Required | Rules                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `id`           | string                                                                                                        | yes      | 16 hexadecimal characters, unique within the trace. Normalized to lowercase.                    |
| `parentSpanId` | string \| null                                                                                                | no       | Default `null`. Must reference another span in the same trace; a span cannot be its own parent. |
| `name`         | string                                                                                                        | yes      | 1–500 characters.                                                                               |
| `kind`         | `"llm"` \| `"agent"` \| `"tool"` \| `"chain"` \| `"retriever"` \| `"embedding"` \| `"reranker"` \| `"custom"` | no       | Default `"custom"`.                                                                             |
| `status`       | `"ok"` \| `"error"` \| `"unset"`                                                                              | no       | Default `"unset"`. Spans with `"error"` are counted in the trace's `errorCount`.                |
| `startedAt`    | string                                                                                                        | yes      | ISO 8601 timestamp.                                                                             |
| `endedAt`      | string                                                                                                        | yes      | ISO 8601 timestamp; must not precede `startedAt`.                                               |
| `provider`     | string                                                                                                        | no       | 1–200 characters.                                                                               |
| `model`        | string                                                                                                        | no       | 1–200 characters.                                                                               |
| `input`        | any JSON value                                                                                                | no       | Stored verbatim.                                                                                |
| `output`       | any JSON value                                                                                                | no       | Stored verbatim.                                                                                |
| `attributes`   | JSON object                                                                                                   | no       | Default `{}`. Free-form; see the error convention below.                                        |
| `events`       | Event[]                                                                                                       | no       | Default `[]`. At most 50 events.                                                                |
| `usage`        | `{ inputTokens?, outputTokens?, totalTokens? }`                                                               | no       | Non-negative integers.                                                                          |
| `costUsd`      | number                                                                                                        | no       | Non-negative.                                                                                   |

### Event object

| Field        | Type        | Required | Rules               |
| ------------ | ----------- | -------- | ------------------- |
| `name`       | string      | yes      | 1–500 characters.   |
| `timestamp`  | string      | yes      | ISO 8601 timestamp. |
| `attributes` | JSON object | no       | Free-form.          |

### Timestamps

Timestamps must match `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` and parse as a valid date. Date-only strings and epoch numbers are rejected. Timestamps are stored as Firestore `Timestamp` values and re-serialized in UTC with millisecond precision, so `2026-09-02T19:01:02.120+00:00` and `2026-09-02T19:01:02.120Z` are the same instant and hash identically.

### Identifiers

- Trace id: 32 hex characters (16 random bytes). Span id: 16 hex characters (8 random bytes). These match OpenTelemetry trace and span id widths.
- Generate ids with a cryptographically secure random source and use a fresh trace id for every run. Reusing a trace id with different content is a `409`.
- Span ids must be unique within the trace. Every non-null `parentSpanId` must name a span in the same request. Zero, one, or many root spans (`parentSpanId: null`) are allowed. Parent chains that form a cycle are rejected.

### Limits

Defined in `LIMITS` in `src/lib/firetrace/schema.ts`.

| Limit                                                  | Value                                       | Result when exceeded    |
| ------------------------------------------------------ | ------------------------------------------- | ----------------------- |
| Spans per trace                                        | 200                                         | `400 invalid_trace`     |
| Events per span                                        | 50                                          | `400 invalid_trace`     |
| Tags per trace / tag length                            | 20 / 64 characters                          | `400 invalid_trace`     |
| Name length (trace, span, event)                       | 500 characters                              | `400 invalid_trace`     |
| Identifier length (provider, model, sessionId, userId) | 200 characters                              | `400 invalid_trace`     |
| Request body                                           | 2 MiB (2,097,152 bytes)                     | `413 payload_too_large` |
| Trace document (trace fields, excluding spans)         | 750 KiB (768,000 bytes) after normalization | `413 payload_too_large` |
| Each span document                                     | 750 KiB (768,000 bytes) after normalization | `413 payload_too_large` |

The request-body limit is checked twice: against the `Content-Length` header before authentication, and against the bytes actually read after authentication. Oversize payloads are rejected outright; content is never silently truncated on the server.

Per-document size is measured two ways and the larger value must stay under 750 KiB: the serialized JSON length, and an estimate using Firestore's own accounting (strings as UTF-8 bytes + 1, numbers as 8 bytes, booleans and null as 1 byte, plus each field name). The second check keeps numeric-heavy payloads below Firestore's hard 1 MiB document limit.

JSON values in `input`, `output`, `metadata`, `attributes`, and event `attributes` must also satisfy Firestore's structural rules, otherwise the request is rejected with `400 invalid_trace`: at most 20 levels of nesting, no empty field names, no field names longer than 1,500 bytes, and no field names of the form `__name__` (including `__proto__`).

## Processing

The route performs these steps in order; the first failure determines the response.

1. Reject if `Content-Length` exceeds 2 MiB (`413`).
2. Authenticate the bearer key and resolve its project (`401`).
3. Read the body; reject if it exceeds 2 MiB (`413`) or is not valid JSON (`400 invalid_json`).
4. Validate against the schema (`400 invalid_trace`), then apply semantic checks: trace and span `endedAt >= startedAt`, unique span ids, no self-parent, parents present, event timestamps parseable, no cycles.
5. Normalize: lowercase ids, re-serialize timestamps as UTC ISO strings, compute `durationMs` for the trace and each span, compute `spanCount` and `errorCount` (spans with `status: "error"`), drop `undefined` fields, and apply defaults.
6. Check the 750 KiB per-document limits and sum the serialized sizes into `estimatedBytes` (`413`).
7. Compute `bodyHash = SHA-256(canonical JSON of { trace, spans })`, where canonical JSON sorts object keys recursively and has no whitespace (`src/lib/firetrace/hash.ts`).
8. Run one Firestore transaction (`ingestTrace`): read the project and the trace document, then either write the trace (stamped with the key's `environment` and `keyId`, neither of which is part of the hash), all span documents, the dashboard rollups (one for every environment together, one for the trace's environment), and the project counter deltas (`traceCount`, `spanCount`, `estimatedBytes`, `lastTraceAt`, `updatedAt`), or return a duplicate, or raise a conflict. The transaction is awaited before the response is sent.

### Idempotency

Traces are immutable. Because the hash is computed after normalization, requests that differ only in key order, id letter case, timestamp offset notation, or omitted-versus-explicit default values are considered identical.

| State of `projects/{projectId}/traces/{traceId}` | Result                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Does not exist                                   | Stored; `201` with `"duplicate": false`; counters incremented       |
| Exists with the same `bodyHash`                  | Nothing written; `200` with `"duplicate": true`; counters unchanged |
| Exists with a different `bodyHash`               | `409 trace_id_conflict`; nothing written                            |

Retrying a request after a timeout is therefore safe. [Patching metadata](#updating-metadata) deliberately leaves `bodyHash` alone, so a resend of the original body is still a duplicate rather than a conflict.

## Responses

### Success (`201` created, `200` duplicate)

```json
{
  "ok": true,
  "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
  "projectId": "5eedc0ffee5eedc0ffee5eed",
  "spanCount": 2,
  "duplicate": false,
  "requestId": "0f1e2d3c4b5a6978"
}
```

The trace is then visible at `/projects/{projectId}/traces/{traceId}` on the deployment.

### Errors

All errors use one envelope (`src/lib/firetrace/errors.ts`):

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "The project API key is missing, invalid, or revoked.",
    "requestId": "0f1e2d3c4b5a6978"
  }
}
```

| HTTP | `code`              | When                                                                                                                                                                                                              | Retry?                                               |
| ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 400  | `invalid_json`      | Body is not valid JSON.                                                                                                                                                                                           | No; fix the request.                                 |
| 400  | `invalid_trace`     | Schema violation or semantic check failure. The message names up to five failing paths and rules; it can include field names and span ids but not the contents of `input`, `output`, `metadata`, or `attributes`. | No; fix the request.                                 |
| 401  | `invalid_api_key`   | Missing, malformed, unknown, wrong, or revoked key, or the key's project was deleted.                                                                                                                             | No; obtain a valid key.                              |
| 405  | `invalid_request`   | Method other than `POST`.                                                                                                                                                                                         | No.                                                  |
| 409  | `trace_id_conflict` | The trace id exists with different content.                                                                                                                                                                       | No; use a new trace id.                              |
| 413  | `payload_too_large` | Request body over 2 MiB, or a trace/span document over 750 KiB after normalization.                                                                                                                               | No; reduce content.                                  |
| 429  | `quota_exhausted`   | Firestore refused the write because a quota is exhausted (gRPC `RESOURCE_EXHAUSTED`). Existing data is preserved.                                                                                                 | Yes, with backoff; or free space / upgrade the plan. |
| 500  | `not_configured`    | The deployment's server environment is incomplete (see `src/lib/env/server.ts`).                                                                                                                                  | Not until the owner fixes the deployment.            |
| 500  | `internal_error`    | Unexpected failure. The message contains no internals; quote `requestId` when reporting.                                                                                                                          | Yes, with backoff.                                   |

Server logs for ingestion contain the request id, project id, key id, trace id, counts, timing, and error codes; they never contain the body, the key, or the `Authorization` header.

## Error attribute convention

FireTrace has no dedicated error field. Errors are recorded as attributes, and the dashboard's **Error** tab reads them from a span's `attributes`:

| Attribute       | Fallbacks read by the dashboard | Meaning                 |
| --------------- | ------------------------------- | ----------------------- |
| `error.type`    | `error.name`, `exception.type`  | Error class or category |
| `error.message` | `exception.message`             | Human-readable message  |
| `error.stack`   | `exception.stacktrace`          | Stack trace (optional)  |

Set the span's `status` to `"error"` as well; the Error tab and the trace's `errorCount` are driven by attributes and status respectively. The JavaScript SDK writes `error.type` and `error.message` (and `error.stack` only when `includeErrorStacks: true`) into span `attributes` for `span.end({ error })` and into trace `metadata` for `trace.end({ error })`, and sets the status to `"error"` unless you pass an explicit status. The SDK also records `firetrace.truncated: ["input" | "output"]` in `attributes` or `metadata` when it truncated a value client-side.

Example span with an error:

```json
{
  "id": "b7ad6b7169203331",
  "parentSpanId": "00f067aa0ba902b7",
  "name": "lookup-example",
  "kind": "tool",
  "status": "error",
  "startedAt": "2026-09-02T19:01:03.050Z",
  "endedAt": "2026-09-02T19:01:03.600Z",
  "input": { "tool": "docs.fetch", "url": "https://example.com/vector-search" },
  "attributes": {
    "error.type": "HttpError",
    "error.message": "HTTP 429 Too Many Requests after 2 retries"
  },
  "events": [
    { "name": "retry", "timestamp": "2026-09-02T19:01:03.220Z", "attributes": { "attempt": 1 } },
    { "name": "retry", "timestamp": "2026-09-02T19:01:03.420Z", "attributes": { "attempt": 2 } }
  ]
}
```

## Full example

```bash
curl -X POST https://your-deployment.example/api/v1/traces \
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 1,
    "trace": {
      "id": "42f38ac8295345a7a12c4e3f60d6da23",
      "name": "answer-question",
      "status": "ok",
      "startedAt": "2026-09-02T19:01:02.120Z",
      "endedAt": "2026-09-02T19:01:04.812Z",
      "provider": "example-provider",
      "model": "example-model",
      "sessionId": "session-123",
      "userId": "user-456",
      "tags": ["production", "chat"],
      "input": { "prompt": "Explain vector search" },
      "output": { "text": "..." },
      "metadata": { "route": "/api/chat" },
      "usage": { "inputTokens": 120, "outputTokens": 84, "totalTokens": 204 },
      "costUsd": 0.0012,
      "spans": [
        {
          "id": "00f067aa0ba902b7",
          "parentSpanId": null,
          "name": "answer-question",
          "kind": "agent",
          "status": "ok",
          "startedAt": "2026-09-02T19:01:02.120Z",
          "endedAt": "2026-09-02T19:01:04.812Z",
          "attributes": { "agent.version": "0.3.1" },
          "events": [{ "name": "plan.ready", "timestamp": "2026-09-02T19:01:02.530Z" }]
        },
        {
          "id": "b7ad6b7169203331",
          "parentSpanId": "00f067aa0ba902b7",
          "name": "generate-text",
          "kind": "llm",
          "status": "ok",
          "startedAt": "2026-09-02T19:01:02.350Z",
          "endedAt": "2026-09-02T19:01:04.600Z",
          "provider": "example-provider",
          "model": "example-model",
          "input": { "messages": [{ "role": "user", "content": "Explain vector search" }] },
          "output": { "text": "..." },
          "usage": { "inputTokens": 120, "outputTokens": 84, "totalTokens": 204 },
          "costUsd": 0.0012
        }
      ]
    }
  }'
```

Generating ids in a shell:

```bash
TRACE_ID=$(openssl rand -hex 16)   # 32 hex characters
SPAN_ID=$(openssl rand -hex 8)     # 16 hex characters
```

## Updating metadata

A trace is written once and never rewritten — with two exceptions. **Scores** (`POST /api/v1/traces/{traceId}/scores`, see [api.md](./api.md#scores)) are the place for judgements that only exist after the run finished: a reader's thumbs rating, a reviewer's verdict, an overnight eval result. They are typed, indexed, and listable. **Metadata** is the place for free-form facts that arrive late: a business outcome that resolves hours later, a link to the ticket the run produced.

```http
PATCH /api/v1/traces/{traceId}
Authorization: Bearer ft_live_<keyId>_<secret>
Content-Type: application/json

{ "metadata": { "feedback": 0, "feedbackLabel": "thumbs-down" } }
```

This needs the `traces:write` scope — the same scope the application already holds to record traces, so an embedded SDK key can rate its own traces without a second credential.

### Rules

- **`metadata` is the only field accepted.** The body is strict: `name`, `status`, `spans`, or anything else is a `400 invalid_request` that names the field. Everything the trace was ingested with stays immutable, spans included.
- **The merge is shallow.** A key in the patch replaces that top-level key outright, nested objects included; keys the patch does not mention are left alone. To change one field inside a nested object, send the whole object.
- **Last writer wins.** Two patches of different keys both survive. Two patches of the same key resolve to whichever committed last, with no record that the other happened — there is no history and no conflict detection.
- **`bodyHash` is not recomputed.** It keeps describing the body as ingested, so re-sending the original trace after a patch is still recognised as a duplicate (`200`) instead of a `409 trace_id_conflict`. The corollary: after a patch, `bodyHash` no longer describes what the document currently holds.
- **Metadata is not indexed.** `firestore.indexes.json` exempts it, because it holds arbitrary caller JSON and Firestore rejects writes with indexed strings over 1,500 bytes. You cannot filter, order, or aggregate traces by a metadata value, and `GET /api/v1/traces` has no metadata filter. Deriving something like a satisfaction rate means fetching the traces and reducing them client-side.
- **Repeating a patch writes nothing.** When the merge produces exactly what is already stored, the response is `200` with `"changed": false`, and neither the document nor `metadataUpdatedAt` moves.

### What the patch changes

`metadata`, plus two pieces of bookkeeping:

- `metadataUpdatedAt` — a server timestamp, `null` on traces that have never been patched. It is the only way to tell a trace that was edited after ingestion from one that was not, so keep it in mind when reading metadata as evidence.
- `estimatedBytes` on both the trace and its project, adjusted by the size delta, so the storage estimate stays honest.

Nothing else on the trace or its spans is touched.

### Convention

Metadata holds two kinds of thing with nothing structural to separate them: facts the caller knew at ingestion time, and facts added afterwards. Prefixing the later ones (`outcome.*`, `review.*`) keeps them legible to whoever reads the trace next. FireTrace does not enforce this. Ratings, verdicts, and eval results belong in scores, which the trace page, the trace list, and `GET /api/v1/scores` all understand; integrations that recorded them as `feedback.*` metadata before scores existed keep working, but nothing will aggregate them.

### Responses

```json
{
  "ok": true,
  "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
  "metadata": { "route": "/api/chat", "feedback": 0, "feedbackLabel": "thumbs-down" },
  "changed": true,
  "requestId": "0f1e2d3c4b5a6978"
}
```

`metadata` is the full merged object, so a client that lost a race can see what actually won.

| HTTP | `code`               | When                                                                                                                                                                       |
| ---- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `invalid_json`       | Body is not valid JSON.                                                                                                                                                    |
| 400  | `invalid_request`    | `metadata` missing or not an object, a field other than `metadata`, or a key Firestore refuses (empty, `__name__`-shaped, over 1,500 bytes, nested deeper than 20 levels). |
| 401  | `invalid_api_key`    | Missing, malformed, unknown, revoked, or expired key.                                                                                                                      |
| 403  | `insufficient_scope` | The key lacks `traces:write`.                                                                                                                                              |
| 404  | `not_found`          | No such trace in this key's project. A key for one project can never patch another's.                                                                                      |
| 413  | `payload_too_large`  | Request over 2 MiB, or the merged trace document over 750 KiB.                                                                                                             |
| 429  | `quota_exhausted`    | Firestore refused the write. Nothing was stored.                                                                                                                           |

### Example

```bash
curl -X PATCH https://your-deployment.example/api/v1/traces/$TRACE_ID \
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"feedback":1,"feedbackLabel":"thumbs-up"}}'
```

The merged metadata is visible immediately on the trace page's **Metadata** tab.

The TypeScript SDK wraps the same call as `api.patchMetadata(traceId, metadata)` ([packages/sdk-js](../packages/sdk-js/README.md)), and agents can reach it over MCP as `patch_trace_metadata` ([mcp.md](./mcp.md)).

### Migrating the linked-trace workaround

Integrations built before this endpoint existed often recorded a second, zero-duration trace whose metadata pointed back at the real one (`metadata.feedbackFor`). Those stand-ins inflate trace counts, drag down latency averages, and spend quota on records that are not LLM calls. `scripts/backfill-feedback-metadata.ts` folds each one into its target's metadata and deletes it:

```bash
# Dry run first: reports every merge it would make and writes nothing.
pnpm exec tsx scripts/backfill-feedback-metadata.ts --project <projectId>
pnpm exec tsx scripts/backfill-feedback-metadata.ts --project <projectId> --apply
```

Keys are prefixed (`feedback.` by default, `--prefix` to change it) and `feedback.migratedFrom` records which stand-in they came from. A stand-in whose target no longer exists is reported and left in place rather than deleted, so feedback is never destroyed just because it cannot be migrated; one failing candidate is skipped rather than stranding the rest; and re-running is safe. Because metadata is not indexed, finding candidates means scanning the project's traces — expect one document read per trace.

## Reading traces back

Keys with the `traces:read` scope can list and fetch traces; `traces:delete` keys can remove them.

### `GET /api/v1/traces/{traceId}`

One trace with every span:

```json
{
  "trace": {
    "id": "42f38ac8295345a7a12c4e3f60d6da23",
    "name": "answer-question",
    "status": "ok",
    "environment": "production",
    "startedAt": "2026-09-02T19:01:02.120Z",
    "endedAt": "2026-09-02T19:01:04.812Z",
    "durationMs": 2692,
    "provider": null,
    "model": "example-model",
    "sessionId": "session-123",
    "userId": null,
    "tags": [],
    "usage": { "inputTokens": 120, "outputTokens": 84, "totalTokens": 204 },
    "costUsd": null,
    "spanCount": 2,
    "errorCount": 0,
    "estimatedBytes": 4310,
    "ingestedAt": "2026-09-02T19:01:05.004Z",
    "schemaVersion": 1,
    "bodyHash": "…",
    "input": null,
    "output": null,
    "metadata": { "route": "/api/chat" },
    "metadataUpdatedAt": null
  },
  "spans": []
}
```

`durationMs`, `spanCount`, `errorCount`, and `environment` are computed at ingestion, not sent by the caller: the first three from the body, the last from the recording key (`null` when the key has none and on every trace recorded before environments existed). Spans come back ordered by `startedAt`, then id. Trace ids are matched case-insensitively; anything that is not 32 hex characters is a `404 not_found`, as is a trace belonging to another project. `metadataUpdatedAt` and `environment` were added after the first release and are `null` on older traces; a client validating this response strictly must allow the extra keys.

`GET /api/v1/traces` lists traces newest first with cursor pagination and filters on status, model, name, tag, environment, session id, user id, and a time range; its query string is as strict as this endpoint's body (an unknown parameter or value is a `400`). AI agents can read the same data over MCP ([mcp.md](./mcp.md)). Both are documented in [api.md](./api.md). Recording requires the `traces:write` scope. Owners also read traces in the dashboard and can download one trace with its spans as canonical JSON from the trace page (`GET /api/projects/{projectId}/traces/{traceId}/export`, session-cookie authenticated).

## Versioning

`schemaVersion` is `1` and is the only accepted value. Additive changes will keep version 1 and remain backward compatible; a breaking change will introduce a new version number. Fields outside this document are rejected rather than ignored, so clients should not send speculative fields.
