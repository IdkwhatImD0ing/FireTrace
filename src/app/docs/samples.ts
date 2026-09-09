import type { CodeSample } from "@/components/docs/CodeGroup";
import type { IngestRequest, ScoreInput, SpanInput } from "@/lib/firetrace/schema";

/**
 * Copy-paste samples for the introduction page, built against this deployment's
 * own origin. The payloads below are typed against the wire schema and checked
 * against it in tests/unit/docs-samples.test.ts, so they cannot drift into
 * documenting an API the server would reject.
 */

/** The trace the quickstart tells you to send. */
export const FIRST_TRACE: IngestRequest = {
  schemaVersion: 1,
  trace: {
    id: "42f38ac8295345a7a12c4e3f60d6da23",
    name: "answer-question",
    status: "ok",
    startedAt: "2026-09-02T19:01:02.120Z",
    endedAt: "2026-09-02T19:01:04.812Z",
    model: "example-model",
    input: { prompt: "Explain vector search in two sentences." },
    output: {
      text: "Vector search finds items whose embeddings are nearest to a query embedding.",
    },
    usage: { inputTokens: 412, outputTokens: 96, totalTokens: 508 },
    tags: [],
    metadata: {},
    spans: [
      {
        id: "00f067aa0ba902b7",
        parentSpanId: null,
        name: "generate-text",
        kind: "llm",
        status: "ok",
        startedAt: "2026-09-02T19:01:02.145Z",
        endedAt: "2026-09-02T19:01:04.780Z",
        model: "example-model",
        attributes: {},
        events: [],
        usage: {},
      },
    ],
  },
};

/** The error convention: status plus `error.*` attributes, no dedicated field. */
export const FAILING_SPAN: SpanInput = {
  id: "b7ad6b7169203331",
  parentSpanId: "00f067aa0ba902b7",
  name: "lookup-example",
  kind: "tool",
  status: "error",
  startedAt: "2026-09-02T19:01:03.050Z",
  endedAt: "2026-09-02T19:01:03.600Z",
  input: { tool: "docs.fetch", url: "https://example.com/vector-search" },
  attributes: {
    "error.type": "HttpError",
    "error.message": "HTTP 429 Too Many Requests after 2 retries",
  },
  events: [
    { name: "retry", timestamp: "2026-09-02T19:01:03.220Z", attributes: { attempt: 1 } },
    { name: "retry", timestamp: "2026-09-02T19:01:03.420Z", attributes: { attempt: 2 } },
  ],
  usage: {},
};

export const HELPFUL_SCORE: ScoreInput = {
  name: "helpful",
  dataType: "boolean",
  value: true,
  comment: "answered the question",
};

/** Pretty-printed JSON, every line after the first indented to sit under the shell flag. */
function json(value: unknown, indent = ""): string {
  return JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

export function mcpSamples(appUrl: string): CodeSample[] {
  return [
    {
      label: "Claude Code",
      icon: "terminal",
      hint: "Run in terminal",
      lang: "bash",
      code: `claude mcp add --transport http firetrace ${appUrl}/api/mcp \\
  --header "Authorization: Bearer ft_live_..."`,
    },
    {
      label: "JSON clients",
      icon: "braces",
      hint: "Cursor, Claude Desktop",
      lang: "json",
      code: `{
  "mcpServers": {
    "firetrace": {
      "type": "http",
      "url": "${appUrl}/api/mcp",
      "headers": { "Authorization": "Bearer ft_live_..." }
    }
  }
}`,
    },
    {
      label: "stdio",
      icon: "plug",
      hint: "Local-process clients",
      lang: "json",
      code: `{
  "mcpServers": {
    "firetrace": {
      "command": "npx",
      "args": ["-y", "@firetrace/mcp"],
      "env": {
        "FIRETRACE_ENDPOINT": "${appUrl}",
        "FIRETRACE_API_KEY": "ft_live_..."
      }
    }
  }
}`,
    },
    {
      label: "Your own agent",
      icon: "code",
      hint: "TypeScript",
      lang: "ts",
      code: `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("${appUrl}/api/mcp"), {
  requestInit: { headers: { Authorization: \`Bearer \${process.env.FIRETRACE_API_KEY}\` } },
});
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const failures = await client.callTool({
  name: "list_traces",
  arguments: { status: "error", limit: 10 },
});`,
    },
  ];
}

export function recordSamples(appUrl: string): CodeSample[] {
  return [
    {
      label: "cURL",
      lang: "bash",
      code: `curl -s -X POST ${appUrl}/api/v1/traces \\
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${json(FIRST_TRACE, "  ")}'`,
    },
    {
      label: "TypeScript SDK",
      lang: "ts",
      code: `import { FireTrace } from "@firetrace/sdk";

const client = new FireTrace({
  endpoint: process.env.FIRETRACE_ENDPOINT!, // "${appUrl}"
  apiKey: process.env.FIRETRACE_API_KEY!, // "ft_live_<keyId>_<secret>"
  onError: (err) => console.warn("firetrace:", err.code, err.message),
});

const trace = client.startTrace("answer-question", {
  model: "example-model",
  input: { prompt },
});
const llm = trace.startSpan("generate-text", { kind: "llm", model: "example-model" });

const result = await callModel();
llm.end({ status: "ok", output: { text: result.text }, usage: result.usage });

const sent = await trace.end({ status: "ok", output: { text: result.text } });
if (sent.ok) console.log(sent.response.traceId, sent.response.duplicate);`,
    },
    {
      label: "fetch",
      lang: "ts",
      code: `const body = {
  schemaVersion: 1,
  trace: {
    id: crypto.randomUUID().replaceAll("-", ""), // 32 hex characters
    name: "answer-question",
    status: "ok",
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    model: "example-model",
    input: { prompt },
    output: { text },
    spans: [],
  },
};

const res = await fetch("${appUrl}/api/v1/traces", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.FIRETRACE_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
if (!res.ok) console.warn("firetrace:", res.status, await res.text());`,
    },
  ];
}

/** The deep-dive section: what the quickstart leaves out — span trees and errors. */
export function spanSamples(): CodeSample[] {
  return [
    {
      label: "Nested spans",
      lang: "ts",
      code: `const trace = client.startTrace("answer-question", { input: { prompt } });

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
llm.end({ status: "ok", output: { text }, usage, costUsd });

agent.end({ status: "ok" });
await trace.end({ status: "ok", output: { text }, usage });`,
    },
    {
      label: "A failing span",
      lang: "json",
      code: json(FAILING_SPAN),
    },
  ];
}

export function readSamples(appUrl: string): CodeSample[] {
  return [
    {
      label: "cURL",
      lang: "bash",
      code: `curl -s "${appUrl}/api/v1/traces?status=error&limit=5" \\
  -H "Authorization: Bearer $FIRETRACE_API_KEY"`,
    },
    {
      label: "TypeScript SDK",
      lang: "ts",
      code: `import { FireTraceApi } from "@firetrace/sdk";

const api = new FireTraceApi({
  endpoint: "${appUrl}",
  apiKey: process.env.FIRETRACE_API_KEY!,
});

const page = await api.listTraces({ status: "error", limit: 20 });
const detail = await api.getTrace(page.traces[0].id); // trace, spans and scores
for await (const trace of api.iterateTraces({ model: "example-model" })) console.log(trace.id);`,
    },
    {
      label: "Agent prompt",
      lang: "text",
      code: `Using the firetrace MCP server, list the last 10 error traces in this
project. For the slowest one, find the failing span with find_spans, read
the surrounding input and output with get_trace, and tell me what broke.
Then record your verdict on that trace with add_score.`,
    },
  ];
}

export function scoreSamples(appUrl: string): CodeSample[] {
  return [
    {
      label: "cURL",
      lang: "bash",
      code: `curl -s -X POST ${appUrl}/api/v1/traces/$TRACE_ID/scores \\
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(HELPFUL_SCORE)}'`,
    },
    {
      label: "TypeScript SDK",
      lang: "ts",
      code: `await api.addScore(traceId, {
  name: "helpful",
  dataType: "boolean",
  value: true,
  comment: "answered the question",
});

// Every "helpful" score across the project, newest first.
const helpful = await api.listScores({ name: "helpful", limit: 100 });`,
    },
  ];
}

/** Response bodies shown in the collapsed disclosures, verbatim from the reference docs. */
export const INGEST_RESPONSE: CodeSample[] = [
  {
    label: "JSON",
    lang: "json",
    code: `{
  "ok": true,
  "traceId": "42f38ac8295345a7a12c4e3f60d6da23",
  "projectId": "5eedc0ffee5eedc0ffee5eed",
  "spanCount": 1,
  "duplicate": false,
  "requestId": "0f1e2d3c4b5a6978"
}`,
  },
];

export const LIST_RESPONSE: CodeSample[] = [
  {
    label: "JSON",
    lang: "json",
    code: `{
  "traces": [
    {
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
}`,
  },
];

export const SCORE_RESPONSE: CodeSample[] = [
  {
    label: "JSON",
    lang: "json",
    code: `{
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
}`,
  },
];
