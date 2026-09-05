import Link from "next/link";
import { CopyButton } from "@/components/ui/CopyButton";
import { redactedKeyReference } from "@/lib/firetrace/api-key-format";
import { environmentLabel } from "@/lib/firetrace/environment";
import type { ApiKeySummary } from "@/lib/firetrace/types";

/**
 * The prompt a user pastes into their coding agent to have it instrument their
 * own application. It carries this deployment's endpoint and the URLs of the
 * reference the agent should read, so the panel does not repeat the docs.
 */
export function integrationPrompt({
  appUrl,
  projectId,
}: {
  appUrl: string;
  projectId: string;
}): string {
  return `Instrument this project with FireTrace so every completed LLM or agent run is recorded as one trace.

FireTrace is a self-hosted tracing service. My deployment:
- Ingest endpoint (not a secret; keep it in code or config): POST ${appUrl}/api/v1/traces
- Auth: send "Authorization: Bearer <key>" with the key read from the FIRETRACE_API_KEY environment variable. I have already put the key in .env myself — never hard-code it, never log it, never commit it. Add a FIRETRACE_API_KEY= placeholder to .env.example if this project has one.
- Environments: the key decides the environment (production, preview, development) and FireTrace stamps it on every trace server-side, so never send an "environment" field. Read FIRETRACE_API_KEY from the host's per-environment secret scope (a different key per environment) rather than sharing one key across environments.
- Contract: fetch ${appUrl}/api/v1/openapi.json for the machine-readable schema, or read ${appUrl}/docs/ingestion-api. Follow it exactly; the API is strict and rejects unknown fields with 400.

Do this:
1. Read the codebase and list every place where an LLM or agent run starts and ends (chat handlers, agent loops, tool calls, retrieval steps). Show me that list and your plan before you change anything.
2. Add one small tracing helper that POSTs the payload with the language's built-in HTTP client. Do not add a dependency.
3. Record one trace per completed run: a fresh 32-hex id, and one span per meaningful step with a 16-hex id that is unique within the trace and a parentSpanId linking the spans into a single tree. Set name, kind (llm, agent, tool, chain, retriever, embedding, reranker or custom), status (ok or error), ISO 8601 startedAt and endedAt, provider and model, and usage tokens whenever the provider returns them. Put the run's request and result in the trace input and output, and fill sessionId and userId wherever the code already has them — those are the dashboard's filters. At most 200 spans per trace, 2 MiB per request.
4. Send once, after the run has finished — never mid-stream and never in the way of the user's response. Tracing must not be able to break the app: catch every failure from the send, log a warning, and carry on. Retry only network errors, 429 and 5xx with backoff; any other 4xx means the payload is wrong, so fix it instead of retrying.
5. Redact secrets and personal data from input, output, metadata and attributes before sending. FireTrace stores traces forever; nothing expires.
6. Verify: run one real flow and confirm the API answered 201 (a 200 with "duplicate": true means the same trace id and body was sent twice). Then tell me to open ${appUrl}/projects/${projectId} and check the trace's span tree, waterfall and inspector.

Finish by reporting which files you changed, where traces are created, and anything you deliberately left uninstrumented.`;
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
  const prompt = integrationPrompt({ appUrl, projectId });
  return (
    <section className="card p-5" aria-labelledby="setup-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="setup-title" className="font-display text-2xl text-ink">
            Send traces to this project
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Put a key in your app&apos;s <code className="font-mono text-ink">.env</code> as{" "}
            <code className="font-mono text-ink">FIRETRACE_API_KEY</code>, then paste the prompt
            below into your coding agent. It reads the API reference from this deployment and wires
            up the tracing itself.
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
                  ({activeKeys[0].label}; scopes {activeKeys[0].scopes.join(", ")}; environment{" "}
                  {environmentLabel(activeKeys[0].environment)}; plaintext shown once at creation)
                </span>
              </span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="mono-label">Prompt for your coding agent</span>
          <CopyButton text={prompt} label="Copy prompt" className="btn btn-primary btn-sm" />
        </div>
        <pre className="pre mt-1.5 max-h-96 overflow-y-auto">{prompt}</pre>
      </div>

      <p className="mt-3 text-xs text-ink-3">
        Wiring it up by hand instead? The{" "}
        <Link href="/docs/ingestion-api" className="underline">
          ingestion API
        </Link>
        ,{" "}
        <Link href="/docs/api" className="underline">
          REST API
        </Link>{" "}
        and{" "}
        <Link href="/docs/mcp" className="underline">
          MCP server
        </Link>{" "}
        are documented in full.
      </p>
    </section>
  );
}
