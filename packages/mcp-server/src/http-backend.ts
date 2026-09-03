import {
  BackendError,
  type ListTracesQuery,
  type ProjectLike,
  type RecordResult,
  type TraceBackend,
  type TraceDetailLike,
  type TracePageLike,
} from "./backend.ts";

export interface HttpBackendOptions {
  /** Deployment origin, e.g. https://fire-trace.vercel.app */
  endpoint: string;
  /** ft_live_... key. Its scopes decide which tools the server exposes. */
  apiKey: string;
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
}

interface KeyInfo {
  keyId: string;
  projectId: string;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * TraceBackend over the REST API. Used by the stdio CLI so any MCP client
 * (Claude Desktop, Cursor, Claude Code...) can talk to a deployment without
 * Firebase credentials.
 */
export class HttpBackend implements TraceBackend {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private info: KeyInfo | null = null;

  constructor(options: HttpBackendOptions) {
    if (!/^https?:\/\//.test(options.endpoint)) {
      throw new Error("FIRETRACE_ENDPOINT must be an http(s) origin.");
    }
    if (!/^ft_live_[0-9a-f]{16}_[0-9a-f]{64}$/.test(options.apiKey)) {
      throw new Error("FIRETRACE_API_KEY does not look like a FireTrace key (ft_live_...).");
    }
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Validate the key and learn its scopes. Must run before building the server. */
  async init(): Promise<KeyInfo> {
    this.info = await this.request<KeyInfo>("GET", "/api/v1/key");
    return this.info;
  }

  get scopes(): readonly string[] {
    return this.info?.scopes ?? [];
  }

  get projectId(): string {
    return this.info?.projectId ?? "";
  }

  getProject(): Promise<ProjectLike> {
    return this.request<ProjectLike>("GET", "/api/v1/project");
  }

  listTraces(query: ListTracesQuery): Promise<TracePageLike> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      sp.set(k === "cursor" ? "after" : k, String(v));
    }
    const qs = sp.toString();
    return this.request<TracePageLike>("GET", `/api/v1/traces${qs ? `?${qs}` : ""}`);
  }

  async getTrace(traceId: string): Promise<TraceDetailLike | null> {
    try {
      return await this.request<TraceDetailLike>("GET", `/api/v1/traces/${traceId}`);
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return null;
      throw err;
    }
  }

  recordTrace(body: unknown): Promise<RecordResult> {
    return this.request<RecordResult>("POST", "/api/v1/traces", body);
  }

  async deleteTrace(traceId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/traces/${traceId}`);
  }

  async ingestSchema(): Promise<unknown> {
    const doc = await this.request<{ components?: { schemas?: Record<string, unknown> } }>(
      "GET",
      "/api/v1/openapi.json",
    );
    return doc.components?.schemas?.IngestRequest ?? doc;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new BackendError(
        0,
        "network_error",
        `Request to ${path} failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const textBody = await res.text();
    let parsed: unknown = null;
    if (textBody) {
      try {
        parsed = JSON.parse(textBody);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new BackendError(
        res.status,
        e?.code ?? `http_${res.status}`,
        e?.message ?? `HTTP ${res.status} from ${path}`,
      );
    }
    return parsed as T;
  }
}
