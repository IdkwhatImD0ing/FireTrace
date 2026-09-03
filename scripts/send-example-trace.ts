/**
 * Send a sample nested trace (agent root, LLM span, tool span) to a FireTrace
 * deployment using the SDK.
 *
 *   FIRETRACE_ENDPOINT=http://localhost:3000 FIRETRACE_API_KEY=ft_live_... pnpm trace:example
 */
import { FireTrace } from "@firetrace/sdk";

const endpoint =
  process.env.FIRETRACE_ENDPOINT ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const apiKey = process.env.FIRETRACE_API_KEY;
if (!apiKey) {
  console.error(
    "Set FIRETRACE_API_KEY to a project key (create one under Project settings -> API keys).",
  );
  process.exit(1);
}

const client = new FireTrace({
  endpoint,
  apiKey,
  throwOnError: true,
  redact: (value, path) => (path[path.length - 1] === "apiKey" ? "[redacted]" : value),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const trace = client.startTrace("answer-question", {
    sessionId: "session-123",
    userId: "user-456",
    tags: ["example", "chat"],
    provider: "example-provider",
    model: "example-model",
    input: { prompt: "Explain vector search in two sentences." },
    metadata: { route: "/api/chat", apiKey: "this value is redacted by the hook" },
  });

  const agent = trace.startSpan("answer-question", {
    kind: "agent",
    attributes: { "agent.version": "0.3.1" },
  });
  agent.addEvent("plan.ready", { steps: 2 });

  const tool = agent.startSpan("lookup-example", {
    kind: "tool",
    input: { tool: "docs.fetch", url: "https://example.com" },
  });
  await sleep(120);
  tool.end({ status: "ok", output: { status: 200, bytes: 4812 } });

  const llm = agent.startSpan("generate-text", {
    kind: "llm",
    provider: "example-provider",
    model: "example-model",
    input: { messages: [{ role: "user", content: "Write the two-sentence explanation." }] },
  });
  await sleep(250);
  llm.end({
    status: "ok",
    output: {
      text: "Vector search finds the nearest embeddings to a query. It favors meaning over exact words.",
    },
    usage: { inputTokens: 120, outputTokens: 84, totalTokens: 204 },
    costUsd: 0.0012,
  });

  agent.end({ status: "ok" });
  const result = await trace.end({
    status: "ok",
    output: {
      text: "Vector search finds the nearest embeddings to a query. It favors meaning over exact words.",
    },
    usage: { inputTokens: 120, outputTokens: 84, totalTokens: 204 },
    costUsd: 0.0012,
  });
  await client.shutdown();

  if (result.ok) {
    const r = result.response;
    console.log(
      `${r.duplicate ? "Duplicate of existing" : "Stored"} trace ${r.traceId} (${r.spanCount} spans) in project ${r.projectId}`,
    );
    console.log(
      `View it: ${endpoint.replace(/\/+$/, "").replace(/\/api\/v1\/traces$/, "")}/projects/${r.projectId}/traces/${r.traceId}`,
    );
  } else {
    console.error("Ingest failed:", result.error.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
