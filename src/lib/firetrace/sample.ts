import type { IngestRequest } from "./schema";

/**
 * Deterministic sample trace: an agent root, a retriever, two LLM spans and a
 * tool span. Contains no real prompts, credentials, or personal data. Used by
 * the landing preview, the emulator seed, and tests.
 */
export function sampleTraceRequest(
  overrides: Partial<{ id: string; name: string; startedAt: string }> = {},
): IngestRequest {
  const base = Date.parse(overrides.startedAt ?? "2026-09-02T19:01:02.120Z");
  const t = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  return {
    schemaVersion: 1,
    trace: {
      id: overrides.id ?? "42f38ac8295345a7a12c4e3f60d6da23",
      name: overrides.name ?? "answer-question",
      status: "ok",
      startedAt: t(0),
      endedAt: t(2692),
      provider: "example-provider",
      model: "example-model",
      sessionId: "session-123",
      userId: "user-456",
      tags: ["sample", "chat"],
      input: { prompt: "Explain vector search in two sentences." },
      output: {
        text: "Vector search finds items whose embeddings are nearest to a query embedding. It trades exact matching for semantic similarity.",
      },
      metadata: { route: "/api/chat", region: "local" },
      usage: { inputTokens: 412, outputTokens: 96, totalTokens: 508 },
      costUsd: 0.0012,
      spans: [
        {
          id: "00f067aa0ba902b7",
          parentSpanId: null,
          name: "answer-question",
          kind: "agent",
          status: "ok",
          startedAt: t(0),
          endedAt: t(2692),
          attributes: { "agent.version": "0.3.1", "agent.steps": 4 },
          events: [{ name: "plan.ready", timestamp: t(410), attributes: { steps: 3 } }],
        },
        {
          id: "3c1f5a9e8b2d4c60",
          parentSpanId: "00f067aa0ba902b7",
          name: "plan",
          kind: "llm",
          status: "ok",
          startedAt: t(25),
          endedAt: t(405),
          provider: "example-provider",
          model: "example-model",
          input: {
            messages: [{ role: "user", content: "Plan how to answer: explain vector search." }],
          },
          output: { text: "1. Retrieve definitions. 2. Check an example. 3. Write two sentences." },
          attributes: { temperature: 0.2 },
          events: [],
          usage: { inputTokens: 120, outputTokens: 36, totalTokens: 156 },
          costUsd: 0.0003,
        },
        {
          id: "9b7c2e4f1a3d5e60",
          parentSpanId: "00f067aa0ba902b7",
          name: "search-notes",
          kind: "retriever",
          status: "ok",
          startedAt: t(430),
          endedAt: t(910),
          input: { query: "vector search definition", topK: 3 },
          output: { hits: 3, topScore: 0.87 },
          attributes: { index: "notes-v2" },
          events: [],
        },
        {
          id: "b7ad6b7169203331",
          parentSpanId: "00f067aa0ba902b7",
          name: "lookup-example",
          kind: "tool",
          status: "error",
          startedAt: t(930),
          endedAt: t(1480),
          input: { tool: "docs.fetch", url: "https://example.com/vector-search" },
          attributes: {
            "error.type": "HttpError",
            "error.message": "HTTP 429 Too Many Requests after 2 retries",
          },
          events: [
            { name: "retry", timestamp: t(1100), attributes: { attempt: 1 } },
            { name: "retry", timestamp: t(1300), attributes: { attempt: 2 } },
          ],
        },
        {
          id: "d4e5f6a7b8c9d0e1",
          parentSpanId: "00f067aa0ba902b7",
          name: "generate-text",
          kind: "llm",
          status: "ok",
          startedAt: t(1500),
          endedAt: t(2650),
          provider: "example-provider",
          model: "example-model",
          input: { messages: [{ role: "user", content: "Write the two-sentence explanation." }] },
          output: {
            text: "Vector search finds items whose embeddings are nearest to a query embedding. It trades exact matching for semantic similarity.",
          },
          attributes: { temperature: 0.7 },
          events: [],
          usage: { inputTokens: 292, outputTokens: 60, totalTokens: 352 },
          costUsd: 0.0009,
        },
      ],
    },
  };
}
