import Link from "next/link";
import { CopyButton } from "@/components/ui/CopyButton";
import { redactedKeyReference } from "@/lib/firetrace/api-key-format";
import type { ApiKeySummary } from "@/lib/firetrace/types";

export function sdkExample(endpoint: string): string {
  return `import { FireTrace } from "@firetrace/sdk";

const client = new FireTrace({
  endpoint: "${endpoint}",
  apiKey: process.env.FIRETRACE_API_KEY!,
});

const trace = client.startTrace("answer-question", {
  sessionId: "session-123",
  input: { prompt },
});
const span = trace.startSpan("generate-text", { kind: "llm", model: "example-model" });
const result = await callModel();
span.end({ status: "ok", output: { text: result.text }, usage: result.usage });
await trace.end({ status: "ok", output: { text: result.text } });`;
}

export function curlExample(endpoint: string): string {
  return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer $FIRETRACE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "schemaVersion": 1,
    "trace": {
      "id": "42f38ac8295345a7a12c4e3f60d6da23",
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
  }'`;
}

/** MCP client configuration (Claude Code, Claude Desktop, Cursor, …) for the remote endpoint. */
export function mcpExample(appUrl: string): string {
  return `{
  "mcpServers": {
    "firetrace": {
      "type": "http",
      "url": "${appUrl}/api/mcp",
      "headers": { "Authorization": "Bearer ft_live_..." }
    }
  }
}`;
}

export function mcpStdioExample(appUrl: string): string {
  return `FIRETRACE_ENDPOINT=${appUrl} FIRETRACE_API_KEY=ft_live_... npx @firetrace/mcp`;
}

export function SetupPanel({
  projectId,
  appUrl,
  keys,
}: {
  projectId: string;
  appUrl: string;
  keys: ApiKeySummary[];
}) {
  const endpoint = `${appUrl}/api/v1/traces`;
  const activeKeys = keys.filter((k) => !k.revokedAt);
  return (
    <section className="card p-5" aria-labelledby="setup-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="setup-title" className="font-display text-2xl text-ink">
            Send traces to this project
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            One POST per completed run. Full reference in{" "}
            <code className="font-mono text-ink">docs/api.md</code>; agents can also work with
            traces over MCP (<code className="font-mono text-ink">docs/mcp.md</code>).
          </p>
        </div>
        <Link href={`/projects/${projectId}/settings`} className="btn btn-ghost btn-sm">
          Manage keys
        </Link>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-line bg-bg-2 p-3">
          <dt className="mono-label">Endpoint</dt>
          <dd className="mt-1 flex items-center justify-between gap-2 font-mono text-xs break-all text-ink">
            <span>{endpoint}</span>
            <CopyButton text={endpoint} />
          </dd>
        </div>
        <div className="rounded-md border border-line bg-bg-2 p-3">
          <dt className="mono-label">API key</dt>
          <dd className="mt-1 font-mono text-xs text-ink">
            {activeKeys.length === 0 ? (
              <span className="text-ink-2">
                No active key.{" "}
                <Link href={`/projects/${projectId}/settings`} className="underline">
                  Create one
                </Link>
              </span>
            ) : (
              <span>
                {redactedKeyReference(activeKeys[0].id, activeKeys[0].lastFour)}{" "}
                <span className="text-ink-3">
                  ({activeKeys[0].label}; scopes {activeKeys[0].scopes.join(", ")}; plaintext shown
                  once at creation)
                </span>
              </span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="flex items-center justify-between">
            <span className="mono-label">TypeScript SDK</span>
            <CopyButton text={sdkExample(endpoint)} />
          </div>
          <pre className="pre mt-1.5 overflow-x-auto">{sdkExample(endpoint)}</pre>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="mono-label">curl</span>
            <CopyButton text={curlExample(endpoint)} />
          </div>
          <pre className="pre mt-1.5 overflow-x-auto">{curlExample(endpoint)}</pre>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="mono-label">MCP · remote (Claude Code, Cursor, Desktop)</span>
            <CopyButton text={mcpExample(appUrl)} />
          </div>
          <pre className="pre mt-1.5 overflow-x-auto">{mcpExample(appUrl)}</pre>
          <p className="mt-1.5 text-xs text-ink-3">
            Tools offered follow the key&apos;s scopes: read keys can list and inspect traces, write
            keys can record them, delete keys can remove them.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="mono-label">MCP · stdio bridge</span>
            <CopyButton text={mcpStdioExample(appUrl)} />
          </div>
          <pre className="pre mt-1.5 overflow-x-auto">{mcpStdioExample(appUrl)}</pre>
          <p className="mt-1.5 text-xs text-ink-3">
            For clients that only speak stdio. It calls the REST API with the same key; no Firebase
            credentials leave the deployment.
          </p>
        </div>
      </div>
    </section>
  );
}
