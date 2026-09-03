import { createFireTraceMcpServer } from "@firetrace/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { NextRequest } from "next/server";
import { ConfigError, serverEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { authenticateApiKey, requireTrialModeForKey, touchApiKey } from "@/lib/firetrace/api-auth";
import { ApiError } from "@/lib/firetrace/errors";
import { newRequestId } from "@/lib/firetrace/ids";
import { log } from "@/lib/log";
import { FirestoreBackend } from "@/lib/mcp/firestore-backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_VERSION = process.env.npm_package_version ?? "0.1.0";

function rpcError(
  status: number,
  code: number,
  message: string,
  requestId: string,
  headers?: HeadersInit,
) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...headers,
    },
  });
}

/**
 * POST /api/mcp — stateless Streamable HTTP MCP endpoint. Same bearer key as
 * the REST API; the tools offered depend on the key's scopes. Each request
 * builds a fresh server + transport, so nothing is shared between callers.
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const env = serverEnv();
    const db = adminDb();
    const auth = await authenticateApiKey(db, request.headers.get("authorization"), env.keyPepper);
    requireTrialModeForKey(auth, env.trialTraceLimit);
    const backend = new FirestoreBackend(db, env, auth);
    const server = createFireTraceMcpServer(backend, { version: APP_VERSION });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    void touchApiKey(db, auth);
    try {
      response.headers.set("cache-control", "no-store");
      response.headers.set("x-request-id", requestId);
    } catch {
      // immutable headers on some response kinds; ignore
    }
    return response;
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", "mcp.not_configured", { requestId, problems: err.problems });
      return rpcError(500, -32000, "This deployment is not configured.", requestId);
    }
    if (err instanceof ApiError) {
      const headers =
        err.status === 401
          ? { "www-authenticate": 'Bearer realm="firetrace", error="invalid_token"' }
          : undefined;
      return rpcError(err.status, -32000, `${err.code}: ${err.message}`, requestId, headers);
    }
    log("error", "mcp.failed", { requestId, error: err });
    return rpcError(500, -32603, "Internal error.", requestId);
  }
}

/** Stateless deployments have no server-initiated stream or session to end. */
export async function GET() {
  return rpcError(
    405,
    -32000,
    "Method not allowed. This endpoint is stateless; use POST.",
    newRequestId(),
    {
      allow: "POST",
    },
  );
}

export async function DELETE() {
  return rpcError(
    405,
    -32000,
    "Method not allowed. This endpoint is stateless; use POST.",
    newRequestId(),
    {
      allow: "POST",
    },
  );
}
