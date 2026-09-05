import { describe, expect, it, vi } from "vitest";
import { chatCompletion, LlmError } from "@/lib/eval/llm";

const cfg = { baseUrl: "https://llm.example/v1/", apiKey: "sk-test", model: "judge-1" };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    model: "judge-1-2026",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    ...extra,
  };
}

/** Fake fetch that answers from a queue of responses or thrown errors. */
function fakeFetch(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const quick = { retryDelayMs: 0 };

describe("chatCompletion", () => {
  it("posts an OpenAI-style body with the bearer key and parses the answer", async () => {
    const { impl, calls } = fakeFetch(reply(completion('{"value":1}')));
    const result = await chatCompletion(cfg, {
      messages: [{ role: "user", content: "judge this" }],
      responseFormat: { type: "json_object" },
      temperature: 0,
      fetchImpl: impl,
      ...quick,
    });
    expect(result).toMatchObject({
      content: '{"value":1}',
      model: "judge-1-2026",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: "judge-1",
      messages: [{ role: "user", content: "judge this" }],
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("honours a per-call model override and content given as parts", async () => {
    const { impl, calls } = fakeFetch(
      reply(
        completion([
          { type: "text", text: "yes" },
          { type: "text", text: "!" },
        ]),
      ),
    );
    const result = await chatCompletion(cfg, {
      messages: [{ role: "user", content: "?" }],
      model: "judge-2",
      fetchImpl: impl,
      ...quick,
    });
    expect(result.content).toBe("yes!");
    expect(JSON.parse(calls[0].init.body as string).model).toBe("judge-2");
  });

  it("retries once after a 5xx, a 429, a network error or a timeout", async () => {
    for (const first of [
      reply({ error: { message: "overloaded" } }, 503),
      reply({ error: { message: "slow down" } }, 429),
      new TypeError("fetch failed"),
    ]) {
      const { impl, calls } = fakeFetch(first, reply(completion("ok")));
      const result = await chatCompletion(cfg, {
        messages: [{ role: "user", content: "?" }],
        fetchImpl: impl,
        ...quick,
      });
      expect(result.content).toBe("ok");
      expect(calls).toHaveLength(2);
    }

    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    await expect(
      chatCompletion(cfg, {
        messages: [{ role: "user", content: "?" }],
        fetchImpl: hanging,
        timeoutMs: 5,
        ...quick,
      }),
    ).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry and reports the provider's message", async () => {
    const { impl, calls } = fakeFetch(
      reply({ error: { message: "overloaded" } }, 503),
      reply({ error: { message: "still overloaded" } }, 503),
    );
    const err = await chatCompletion(cfg, {
      messages: [{ role: "user", content: "?" }],
      fetchImpl: impl,
      ...quick,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: "http", status: 503, retryable: true });
    expect((err as Error).message).toContain("HTTP 503");
    expect((err as Error).message).toContain("still overloaded");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx and surfaces its status for the caller's fallback", async () => {
    const { impl, calls } = fakeFetch(
      reply({ error: { message: "response_format is not supported" } }, 400),
    );
    await expect(
      chatCompletion(cfg, {
        messages: [{ role: "user", content: "?" }],
        fetchImpl: impl,
        ...quick,
      }),
    ).rejects.toMatchObject({ kind: "http", status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("rejects a 200 without a message as malformed", async () => {
    const { impl } = fakeFetch(reply({ object: "list", data: [] }));
    await expect(
      chatCompletion(cfg, {
        messages: [{ role: "user", content: "?" }],
        fetchImpl: impl,
        ...quick,
      }),
    ).rejects.toMatchObject({ kind: "malformed", status: 200, retryable: false });
  });
});
