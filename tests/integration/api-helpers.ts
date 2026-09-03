import "./env";
import { NextRequest } from "next/server";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { GET as keyGet } from "@/app/api/v1/key/route";
import { GET as projectGet } from "@/app/api/v1/project/route";
import { DELETE as traceDelete, GET as traceGet } from "@/app/api/v1/traces/[traceId]/route";
import { GET as tracesGet, POST as tracesPost } from "@/app/api/v1/traces/route";

export const BASE_URL = "http://localhost:3000";

export interface ApiCall {
  method?: string;
  path: string;
  apiKey?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * Dispatch a request to the real route handlers the way Next would, without
 * a dev server. Paths mirror the public API.
 */
export async function callApi<T = Record<string, unknown>>(call: ApiCall): Promise<ApiResult<T>> {
  const method = call.method ?? "GET";
  const headers = new Headers({ accept: "application/json", ...call.headers });
  if (call.apiKey) headers.set("authorization", `Bearer ${call.apiKey}`);
  let raw: string | undefined;
  if (call.body !== undefined) {
    raw = typeof call.body === "string" ? call.body : JSON.stringify(call.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const request = new NextRequest(`${BASE_URL}${call.path}`, { method, headers, body: raw });
  const url = new URL(request.url);
  let response: Response;
  const traceMatch = /^\/api\/v1\/traces\/([^/]+)$/.exec(url.pathname);
  if (url.pathname === "/api/v1/traces" && method === "POST") response = await tracesPost(request);
  else if (url.pathname === "/api/v1/traces" && method === "GET")
    response = await tracesGet(request);
  else if (traceMatch && method === "GET")
    response = await traceGet(request, { params: Promise.resolve({ traceId: traceMatch[1] }) });
  else if (traceMatch && method === "DELETE")
    response = await traceDelete(request, { params: Promise.resolve({ traceId: traceMatch[1] }) });
  else if (url.pathname === "/api/v1/project") response = await projectGet(request);
  else if (url.pathname === "/api/v1/key") response = await keyGet(request);
  else if (url.pathname === "/api/mcp" && method === "POST") response = await mcpPost(request);
  else throw new Error(`No test route for ${method} ${url.pathname}`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 0;

/** One JSON-RPC call to the MCP endpoint (stateless Streamable HTTP, JSON responses). */
export async function mcpCall(
  apiKey: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<ApiResult<RpcResponse>> {
  const id = ++rpcId;
  return callApi<RpcResponse>({
    method: "POST",
    path: "/api/mcp",
    apiKey,
    body: { jsonrpc: "2.0", id, method, params },
    headers: { accept: "application/json, text/event-stream" },
  });
}

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function mcpTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ rpc: RpcResponse; result: ToolCallResult | null; text: string }> {
  const res = await mcpCall(apiKey, "tools/call", { name, arguments: args });
  const result = (res.body.result as unknown as ToolCallResult | undefined) ?? null;
  const text = result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { rpc: res.body, result, text };
}

export async function mcpToolNames(apiKey: string): Promise<string[]> {
  const res = await mcpCall(apiKey, "tools/list");
  const tools = (res.body.result?.tools as Array<{ name: string }> | undefined) ?? [];
  return tools.map((t) => t.name).sort();
}
