# FireTrace API

Everything a program can do against a FireTrace deployment goes through the key-authenticated API under `/api/v1`. The dashboard uses a separate session cookie and never shares these routes. A machine-readable OpenAPI 3.1 document is served by every deployment at `GET /api/v1/openapi.json`, and `GET /api/v1` lists the endpoints.

- Base URL: your deployment origin, e.g. `https://tracing.art3m1s.me`
- Authentication: `Authorization: Bearer ft_live_<keyId>_<secret>`
- Content type: JSON in, JSON out. Every response carries `X-Request-Id` and `Cache-Control: no-store`.
- Errors: `{ "error": { "code", "message", "requestId" } }` with a matching HTTP status.

## API keys and scopes

Keys are created per project under **Project → Settings → API keys**. Only an HMAC digest of the secret is stored, so the plaintext is shown once. Each key carries the scopes you choose at creation:

| Scope           | Grants                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `traces:write`  | `POST /api/v1/traces`, `PATCH /api/v1/traces/{id}`, `POST /api/v1/traces/{id}/scores`; MCP `record_trace`, `add_score`, `get_ingest_schema`    |
| `traces:read`   | `GET /api/v1/traces`, `GET /api/v1/traces/{id}`, `GET /api/v1/traces/{id}/scores`, `GET /api/v1/scores`, `GET /api/v1/project`; MCP read tools |
| `traces:delete` | `DELETE /api/v1/traces/{id}`, `DELETE /api/v1/traces/{id}/scores/{scoreId}`; MCP `delete_trace`                                                |

`GET /api/v1/key` needs no scope. Defaults for a new key are `traces:write` + `traces:read`; an SDK embedded in an application usually only needs `traces:write`. Keys created before scopes existed behave as `traces:write` only.

Keys can also carry an expiry (30 days, 90 days, 1 year, or never). Expired, revoked, unknown, and malformed keys all produce the same `401 invalid_api_key` with a `WWW-Authenticate: Bearer` challenge, so a response never reveals whether a key id exists. Calling a route without the required scope yields `403 insufficient_scope`.

Rotating a key issues a new secret with the same label, scopes, and expiry and revokes the old one in the same transaction. `lastUsedAt` is updated at most every five minutes per key so busy keys do not cost a write per request.

## Endpoints

### `GET /api/v1/key`

Describe the calling key. Use it to verify configuration at startup.

```json
{
  "keyId": "3f9c2a1b8d4e6f70",
  "projectId": "proj_8f2c1d",
  "scopes": ["traces:write", "traces:read"],
  "expiresAt": null,
  "lastUsedAt": "2026-09-03T10:12:00.000Z"
}
```

### `GET /api/v1/project` — scope `traces:read`

The key's project with counters and the storage estimate (FireTrace's own serialized-size estimate, not Firebase billing).

```json
{
  "id": "proj_8f2c1d",
  "name": "Support agent",
  "slug": "support-agent",
  "description": "",
  "traceCount": 1240,
  "spanCount": 8114,
  "estimatedBytes": 41230011,
  "lastTraceAt": "2026-09-03T10:11:58.201Z",
  "createdAt": "2026-08-20T18:00:00.000Z",
  "storage": { "limitBytes": 500000000, "level": "ok" },
  "keyScopes": ["traces:write", "traces:read"]
}
```

### `POST /api/v1/traces` — scope `traces:write`

Record one complete, immutable trace. The body is `{ "schemaVersion": 1, "trace": { ... } }`; the full field reference lives in [ingestion-api.md](./ingestion-api.md) and the JSON Schema in the OpenAPI document (`components.schemas.IngestRequest`).

| Status | Meaning                                                                            |
| ------ | ---------------------------------------------------------------------------------- |
| 201    | Stored. Body: `{ ok, traceId, projectId, spanCount, duplicate: false, requestId }` |
| 200    | Identical resend of an existing trace; nothing written (`duplicate: true`)         |
| 400    | `invalid_json` or `invalid_trace` (message names the field)                        |
| 409    | `trace_id_conflict`: the id exists with different content                          |
| 413    | `payload_too_large`: request over 2 MiB or a document over Firestore's limit       |
| 429    | `quota_exhausted`: Firestore refused the write; retry later, nothing was stored    |

Idempotency comes from the trace id: the SDK generates 32-hex ids, and a resend with the same body hash is a no-op.

On instances that enable trial mode (`FIRETRACE_TRIAL_TRACE_LIMIT`), a trial account's project answers `403 trial_limit_reached` once the account has recorded its allotted traces; the message links to the deployment guide. Owner projects are never limited.

### `GET /api/v1/traces` — scope `traces:read`

Newest-first list with cursor pagination. Filters combine with AND.

| Query       | Notes                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| `status`    | `ok`, `error`, or `unset`                                                     |
| `model`     | exact model string                                                            |
| `name`      | exact trace name                                                              |
| `tag`       | one tag the trace must carry                                                  |
| `sessionId` | exact                                                                         |
| `userId`    | exact                                                                         |
| `from`      | inclusive ISO-8601 lower bound on `startedAt`                                 |
| `to`        | inclusive ISO-8601 upper bound on `startedAt`                                 |
| `sort`      | `newest` (default), `slowest` (by `durationMs`) or `costliest` (by `costUsd`) |
| `limit`     | 1–200, default 50                                                             |
| `after`     | `nextCursor` of a previous page (older traces)                                |
| `before`    | `prevCursor` of a previous page (newer traces)                                |

`slowest` and `costliest` combine only with `status`, `model`, `name` and `tag`; adding `sessionId`, `userId`, `from` or `to` to them is a `400 invalid_request`, because Firestore has no index for that combination. `costliest` omits traces that were recorded without `costUsd`. A cursor is only valid under the sort that produced it.

```json
{
  "traces": [
    {
      "id": "42f38ac8295345a7a12c4e3f60d6da23",
      "name": "answer-question",
      "status": "ok",
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
      "spanCount": 5,
      "errorCount": 1,
      "estimatedBytes": 4310,
      "ingestedAt": "2026-09-02T19:01:05.004Z",
      "scores": {
        "helpful": {
          "scoreId": "9c1e7a2b3d4f5061",
          "dataType": "boolean",
          "value": true,
          "evaluatorId": null
        }
      }
    }
  ],
  "nextCursor": "eyJz...",
  "prevCursor": null,
  "pageSize": 50
}
```

Cursors are opaque; an unparseable cursor is `400 invalid_request`. Offsets are never supported because Firestore charges per document read.

### `GET /api/v1/traces/{traceId}` — scope `traces:read`

One trace with all of its spans, ordered by `startedAt` then id, and all of its scores, newest first. Trace ids are matched case-insensitively; anything that is not 32 hex characters is a `404 not_found`, as is a trace that belongs to another project.

```json
{
  "trace": { "...summary fields...", "input": {}, "output": {}, "metadata": {}, "metadataUpdatedAt": null, "bodyHash": "…" },
  "scores": [],
  "spans": [
    {
      "id": "00f067aa0ba902b7",
      "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
      "parentSpanId": null,
      "name": "answer-question",
      "kind": "agent",
      "status": "ok",
      "startedAt": "2026-09-02T19:01:02.120Z",
      "endedAt": "2026-09-02T19:01:04.812Z",
      "durationMs": 2692,
      "provider": null,
      "model": null,
      "input": null,
      "output": null,
      "attributes": {},
      "events": [],
      "usage": null,
      "costUsd": null
    }
  ]
}
```

### `PATCH /api/v1/traces/{traceId}` — scope `traces:write`

Shallow-merge keys into a stored trace's `metadata`. This is the only mutable part of a trace: it exists so evaluations that arrive after the run — a thumbs rating, a reviewer's verdict, an eval score, a business outcome — have somewhere to live. Everything the trace was ingested with, spans included, stays write-once. The full reference is in [ingestion-api.md](./ingestion-api.md#updating-metadata).

```bash
curl -X PATCH https://tracing.art3m1s.me/api/v1/traces/$TRACE_ID \
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"metadata":{"feedback":1,"feedbackLabel":"thumbs-up"}}'
```

```json
{
  "ok": true,
  "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
  "metadata": { "route": "/api/chat", "feedback": 1, "feedbackLabel": "thumbs-up" },
  "changed": true,
  "requestId": "0f1e2d3c4b5a6978"
}
```

| Status | Meaning                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | Merged. `metadata` is the full merged object; `changed: false` means it already matched and nothing was written                       |
| 400    | `invalid_json`, or `invalid_request` — `metadata` missing or not an object, a field other than `metadata`, or a key Firestore refuses |
| 404    | `not_found`: no such trace in this key's project                                                                                      |
| 413    | `payload_too_large`: request over 2 MiB, or the merged document over 750 KiB                                                          |
| 429    | `quota_exhausted`: Firestore refused the write; nothing was stored                                                                    |

Three things to know before you build on it:

- The merge is **shallow** and **last-writer-wins**. A patched key replaces that top-level key outright, and two writers racing on the same key leave no trace of the loser.
- `bodyHash` is **not** recomputed, so re-sending the original trace after a patch is still a `200` duplicate rather than a `409`. It describes the body as ingested, not the document as it stands.
- Metadata is **not indexed**, so there is no metadata filter on `GET /api/v1/traces` and no server-side aggregation. For ratings, verdicts, and eval results use [scores](#scores) instead; keep metadata for free-form facts.

`metadataUpdatedAt` on the trace (see `GET /api/v1/traces/{traceId}`) is the only marker distinguishing a trace that was edited after ingestion from one that was not.

### Scores

A score is a judgement attached to a trace after the run: a thumbs rating, a reviewer's verdict, an evaluator's result. Unlike metadata, scores are a first-class resource: each has a name, a typed value, an optional comment and a source, they are indexed, and they can be listed per trace or across the project. Scores are append-only. Adding a name again records a newer score, and every trace carries a `scores` summary with the newest score per name (see the list example above).

#### `POST /api/v1/traces/{traceId}/scores` — scope `traces:write`

```bash
curl -X POST https://tracing.art3m1s.me/api/v1/traces/$TRACE_ID/scores \
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"helpful","dataType":"boolean","value":true,"comment":"answered the question"}'
```

| Field      | Notes                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `name`     | letters, digits, `_` and `-`, at most 64 characters; doubles as the display name                      |
| `dataType` | `numeric`, `categorical`, or `boolean`                                                                |
| `value`    | a number for `numeric`, a string of at most 200 characters for `categorical`, a boolean for `boolean` |
| `comment`  | optional, at most 2,000 characters                                                                    |
| `spanId`   | optional 16-hex span id when the score applies to one span rather than the whole trace                |

```json
{
  "ok": true,
  "score": {
    "id": "9c1e7a2b3d4f5061",
    "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
    "spanId": null,
    "name": "helpful",
    "dataType": "boolean",
    "value": true,
    "comment": "answered the question",
    "source": "api",
    "evaluatorId": null,
    "runId": null,
    "createdAt": "2026-09-03T10:12:00.000Z"
  },
  "requestId": "0f1e2d3c4b5a6978"
}
```

| Status | Meaning                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------- |
| 201    | Stored                                                                                          |
| 400    | `invalid_json`, or `invalid_request` when the body is not a score (the message names the field) |
| 404    | `not_found`: no such trace in this key's project                                                |
| 409    | `conflict`: the trace already holds 100 scores, the maximum; delete one first                   |
| 429    | `quota_exhausted`: Firestore refused the write; nothing was stored                              |

`source` is `api` for scores recorded through the API or MCP, `annotation` for ones entered on the trace page, and `eval` for ones written by an evaluator.

#### `GET /api/v1/traces/{traceId}/scores` — scope `traces:read`

Every score of one trace, newest first: `{ "traceId", "scores": [ ... ] }`. A trace that does not exist in this project is a `404 not_found`.

#### `GET /api/v1/scores` — scope `traces:read`

Newest-first list across the project with cursor pagination. Filters combine with AND.

| Query   | Notes                                          |
| ------- | ---------------------------------------------- |
| `name`  | exact score name                               |
| `from`  | inclusive ISO-8601 lower bound on `createdAt`  |
| `to`    | inclusive ISO-8601 upper bound on `createdAt`  |
| `limit` | 1–500, default 50                              |
| `after` | `nextCursor` of a previous page (older scores) |

Responds with `{ "scores": [ ... ], "nextCursor": "…" | null, "pageSize": 50 }`. An unparseable cursor is `400 invalid_request`.

#### `DELETE /api/v1/traces/{traceId}/scores/{scoreId}` — scope `traces:delete`

Delete one score. If it was the newest score of its name, the previous one takes its place in the trace's summary. Returns `{ "ok": true, "traceId", "scoreId" }` or `404 not_found`. Deleting a trace deletes its scores with it.

### `DELETE /api/v1/traces/{traceId}` — scope `traces:delete`

Delete the trace, every span and score under it, and any patched metadata with them, then correct the project counters. Returns `{ "ok": true, "traceId" }` or `404 not_found`. This and the dashboard are the only two ways data leaves Firestore: FireTrace never sets TTLs or deletes on its own.

### `POST /api/mcp`

The Model Context Protocol endpoint, documented in [mcp.md](./mcp.md). Same bearer key; tools follow scopes.

## Clients

### TypeScript SDK

`@firetrace/sdk` records traces (`FireTrace`) and, through `client.api()` or `new FireTraceApi(...)`, reads and deletes them:

```ts
import { FireTrace, FireTraceApi } from "@firetrace/sdk";

const api = new FireTraceApi({
  endpoint: "https://tracing.art3m1s.me",
  apiKey: process.env.FIRETRACE_API_KEY!,
});
const key = await api.getKey(); // verify scopes at startup
const page = await api.listTraces({ status: "error", limit: 20 });
for await (const trace of api.iterateTraces({ model: "gpt-5" })) console.log(trace.id);
const detail = await api.getTrace(page.traces[0].id); // null when missing; includes scores
await api.addScore(detail!.trace.id, { name: "helpful", dataType: "boolean", value: true }); // needs traces:write
const helpful = await api.listScores({ name: "helpful", limit: 100 }); // across the project
await api.patchMetadata(detail!.trace.id, { ticket: "SUP-142" }); // needs traces:write
await api.deleteTrace(page.traces[0].id); // needs traces:delete
```

Read methods throw `FireTraceError` with `status`, `code`, and `requestId`; the recording client keeps its never-throw default.

### curl

```bash
curl -s https://tracing.art3m1s.me/api/v1/traces?status=error&limit=5 \
  -H "Authorization: Bearer $FIRETRACE_API_KEY"
```

```bash
curl -s -X DELETE https://tracing.art3m1s.me/api/v1/traces/42f38ac8295345a7a12c4e3f60d6da23 \
  -H "Authorization: Bearer $FIRETRACE_API_KEY"
```

## Operational notes

- Every route is `Cache-Control: no-store`; only `/api/v1/openapi.json` is cacheable.
- Requests are served by Vercel functions on the Node.js runtime; a cold start adds a few hundred milliseconds to the first call.
- Reads cost Firestore document reads (one per trace in a page, one per span in a detail call). Keep `limit` modest and prefer filters over client-side scanning.
- Error codes are stable strings; new codes may be added but existing ones will not change meaning.
