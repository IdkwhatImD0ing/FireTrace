# FireTrace MCP

FireTrace exposes traces to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io). An agent connected to it can find traces, walk span trees, record new traces, and (with the right key) delete them. There are two ways to connect; both use the same project API keys as the REST API.

| Transport                                      | When to use                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Remote** `POST https://<deployment>/api/mcp` | Any client that speaks Streamable HTTP (Claude Code, Claude Desktop, Cursor, custom agents). |
| **stdio** `npx @firetrace/mcp`                 | Clients that only launch local processes. It bridges to the REST API with the same key.      |

Nothing in either path requires Firebase credentials on the client side. The remote endpoint runs inside your deployment with the Admin SDK; the stdio bridge only ever calls the public API.

## Authentication and scopes

Send the key as `Authorization: Bearer ft_live_...`. The tools offered follow the key's scopes, so an agent never sees a tool it cannot use:

| Scope           | Tools                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| `traces:read`   | `get_project`, `list_traces`, `get_trace`, `find_spans`, `list_scores`   |
| `traces:write`  | `record_trace`, `add_score`, `patch_trace_metadata`, `get_ingest_schema` |
| `traces:delete` | `delete_trace`                                                           |

Recommended: give an investigating agent a **read-only** key with an expiry. Add `traces:delete` only for a key used by a cleanup workflow you supervise. A missing or invalid key is answered with HTTP 401 and a `WWW-Authenticate` challenge before any MCP message is processed.

The remote endpoint is stateless: each request builds a fresh server, no session ids are issued, and `GET`/`DELETE` return 405. That keeps the endpoint safe to run on serverless functions and means there is no server-side state an attacker could hijack.

## Connect a client

### Claude Code

```bash
claude mcp add --transport http firetrace https://tracing.art3m1s.me/api/mcp --header "Authorization: Bearer ft_live_..."
```

### Claude Desktop, Cursor, and other JSON-configured clients

```json
{
  "mcpServers": {
    "firetrace": {
      "type": "http",
      "url": "https://tracing.art3m1s.me/api/mcp",
      "headers": { "Authorization": "Bearer ft_live_..." }
    }
  }
}
```

For clients that only support stdio servers:

```json
{
  "mcpServers": {
    "firetrace": {
      "command": "npx",
      "args": ["-y", "@firetrace/mcp"],
      "env": {
        "FIRETRACE_ENDPOINT": "https://tracing.art3m1s.me",
        "FIRETRACE_API_KEY": "ft_live_..."
      }
    }
  }
}
```

From a checkout of this repository the same bridge runs with `pnpm mcp:stdio` (after setting the two environment variables) or, once built with `pnpm mcp:build`, with `node packages/mcp-server/dist/cli.js`.

### From your own agent code

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("https://tracing.art3m1s.me/api/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.FIRETRACE_API_KEY}` } },
});
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);
const failures = await client.callTool({
  name: "list_traces",
  arguments: { status: "error", limit: 10 },
});
```

## Tools

| Tool                   | Input                                                                                                                        | Returns                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project`          | none                                                                                                                         | Name, trace/span counts, storage estimate and level, last trace time, key scopes.                                                                                                                  |
| `list_traces`          | `status`, `model`, `name`, `tag`, `environment`, `sessionId`, `userId`, `from`, `to`, `sort`, `limit` (default 20), `cursor` | One line per trace (id, time, status, duration, name, model, environment, span/error counts) plus a cursor. `sort` is `newest`, `slowest` or `costliest`; `environment` is a slug or `unassigned`. |
| `get_trace`            | `traceId`, `maxChars` (default 2000), `maxSpans` (default 100), `includeContent`                                             | A span outline, then the trace and spans as JSON with long strings truncated.                                                                                                                      |
| `find_spans`           | `traceId`, `kind`, `status`, `nameContains`, `limit`                                                                         | Matching spans without content: id, parent, kind, status, duration, name, model.                                                                                                                   |
| `get_ingest_schema`    | none                                                                                                                         | JSON Schema of the `record_trace` body, derived from the server's validator.                                                                                                                       |
| `record_trace`         | `trace` (the trace object; the server adds `schemaVersion: 1`)                                                               | Stored / already stored, trace id, span count. Validation errors come back as tool errors.                                                                                                         |
| `add_score`            | `traceId`, `name`, `dataType`, `value`, `comment`, `spanId`                                                                  | The stored score. A queryable judgement (rating, verdict, eval result) attached to the trace.                                                                                                      |
| `list_scores`          | `traceId`, `name`, `environment`, `limit` (default 50), `cursor`                                                             | One line per score (id, time, trace, name=value, source, comment) plus a cursor. `environment` is resolved through each score's trace.                                                             |
| `patch_trace_metadata` | `traceId`, `metadata` (keys to merge)                                                                                        | The merged metadata and whether anything changed. For free-form facts, not judgements.                                                                                                             |
| `delete_trace`         | `traceId`, `confirm: true`                                                                                                   | Confirmation. Irreversible; the `confirm` literal guards against accidental calls.                                                                                                                 |

Text results are written for a model to read: outlines, compact lines, and truncation markers such as `…[+3120 chars truncated]`. `list_traces`, `find_spans`, `get_project`, `record_trace`, `add_score`, `list_scores`, `patch_trace_metadata`, and `delete_trace` also return `structuredContent` for programmatic use.

`add_score` is how an agent records a judgement it can later find again: scores are indexed, listable per trace or by name across the project, and shown on the trace page and in the trace list. `patch_trace_metadata` merges shallowly: a key in the patch replaces that top-level key outright, keys it does not mention are left alone, and concurrent writers on one key are last-writer-wins. Everything else about a trace, spans included, stays immutable, and `bodyHash` keeps describing the body as ingested. Metadata is not indexed, so an agent cannot search or filter by what it writes there — see [ingestion-api.md](./ingestion-api.md#updating-metadata).

Suggested workflow for an investigating agent:

1. `list_traces` with `status: "error"` (or a `sessionId`) to find candidates.
2. `find_spans` with `status: "error"` on a candidate to locate the failing span.
3. `get_trace` with a modest `maxChars` to read the surrounding inputs and outputs.
4. `record_trace` to store the agent's own run, if the key can write.
5. `add_score` to record a verdict on a trace it investigated, if the key can write; `list_scores` to review earlier verdicts.

## Running the server elsewhere

`@firetrace/mcp` exports `createFireTraceMcpServer(backend)` and a `TraceBackend` interface, so the same tools can sit on any storage. The dashboard wires it to Firestore in `src/lib/mcp/firestore-backend.ts`; the CLI wires it to the REST API with `HttpBackend`. A custom backend needs nine methods (`getProject`, `listTraces`, `getTrace`, `recordTrace`, `patchTraceMetadata`, `addScore`, `listScores`, `deleteTrace`, `ingestSchema`) plus the key's `scopes` and `projectId`.

## Security summary

- Same key, same digest, same 401 for every failure mode as the REST API ([security.md](./security.md)).
- Scope checks happen when tools are registered and again in the underlying operations, so a forged `tools/call` for an unregistered tool fails.
- Keys are project-bound; a trace id from another project is a 404 from every tool.
- The remote endpoint never streams server-initiated events and never keeps sessions.
- Deletion needs a dedicated scope and an explicit `confirm: true`. Nothing else in FireTrace deletes data.
