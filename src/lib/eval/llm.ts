import "server-only";
import type { EvalConfig } from "@/lib/env/server";
import { log } from "@/lib/log";

/**
 * Minimal client for an OpenAI-compatible `POST {baseUrl}/chat/completions`
 * endpoint, written with fetch so FireTrace takes no provider dependency.
 * Works with OpenAI, Anthropic's compatibility endpoint, Gemini, OpenRouter,
 * Ollama, Vercel AI Gateway and anything else that speaks the same shape.
 *
 * Prompts and completions are never logged; only status, timing and model.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  /** Overrides the configured default model. */
  model?: string;
  /** OpenAI-style `response_format`, e.g. `{ type: "json_schema", json_schema: {...} }`. */
  responseFormat?: Record<string, unknown>;
  temperature?: number;
  /** Per-attempt timeout; default 60 s. */
  timeoutMs?: number;
  /** Delay before the single retry; default 1 s. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  /** The model the endpoint reports having used, when it says. */
  model: string | null;
  usage: ChatUsage | null;
  /** Wall-clock time of the attempt that succeeded. */
  durationMs: number;
}

export type LlmErrorKind = "http" | "network" | "timeout" | "malformed";

/** A failed call. `status` is the HTTP status for kind "http" or "malformed", else null. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly status: number | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

type Attempt = { ok: true; value: ChatCompletionResult } | { ok: false; error: LlmError };

function extractContent(json: unknown): string | null {
  const choice = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof (part as { text?: unknown })?.text === "string" ? part.text : ""))
      .join("");
  }
  return null;
}

function extractUsage(json: unknown): ChatUsage | null {
  const usage = (json as { usage?: Record<string, unknown> })?.usage;
  if (!usage || typeof usage !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: ChatUsage = {};
  const input = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  const total = num(usage.total_tokens);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (total !== undefined) out.totalTokens = total;
  return Object.keys(out).length ? out : null;
}

function providerDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return `: ${message.trim().slice(0, 300)}`;
  } catch {
    // Not JSON; the status alone has to do.
  }
  return "";
}

async function attemptOnce(
  url: string,
  cfg: EvalConfig,
  body: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: new LlmError(
        aborted ? "timeout" : "network",
        null,
        aborted
          ? `The model endpoint did not answer within ${timeoutMs} ms.`
          : "Could not reach the model endpoint.",
        true,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      error: new LlmError(
        "http",
        res.status,
        `The model endpoint answered HTTP ${res.status}${providerDetail(text)}`,
        res.status === 429 || res.status >= 500,
      ),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const content = extractContent(json);
  if (content === null) {
    return {
      ok: false,
      error: new LlmError(
        "malformed",
        res.status,
        "The model endpoint returned a response without a message; is the base URL an OpenAI-compatible /v1 prefix?",
        false,
      ),
    };
  }
  const model = (json as { model?: unknown })?.model;
  return {
    ok: true,
    value: {
      content,
      model: typeof model === "string" ? model : null,
      usage: extractUsage(json),
      durationMs: Date.now() - startedAt,
    },
  };
}

/** One chat completion with a single retry on 429, 5xx, network errors and timeouts. */
export async function chatCompletion(
  cfg: EvalConfig,
  options: ChatCompletionOptions,
): Promise<ChatCompletionResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const model = options.model ?? cfg.model;
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body: Record<string, unknown> = { model, messages: options.messages };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.responseFormat) body.response_format = options.responseFormat;

  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    const result = await attemptOnce(url, cfg, body, timeoutMs, fetchImpl);
    if (result.ok) {
      log("info", "eval.llm.completed", {
        model,
        attempt,
        ms: Date.now() - startedAt,
        totalTokens: result.value.usage?.totalTokens ?? null,
      });
      return result.value;
    }
    if (attempt === 1 && result.error.retryable) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    log("warn", "eval.llm.failed", {
      model,
      attempt,
      ms: Date.now() - startedAt,
      kind: result.error.kind,
      status: result.error.status,
    });
    throw result.error;
  }
}
