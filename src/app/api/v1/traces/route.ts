import type { NextRequest } from "next/server";
import { ConfigError, serverEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorResponse, errorToResponse, jsonResponse } from "@/lib/firetrace/errors";
import { newRequestId } from "@/lib/firetrace/ids";
import { authenticateApiKey, ingestTrace } from "@/lib/firetrace/ingest";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { LIMITS } from "@/lib/firetrace/schema";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/v1/traces — store one complete, immutable trace.
 *   Authorization: Bearer ft_live_<keyId>_<secret>
 *   Body: { schemaVersion: 1, trace: {...} }  (see docs/ingestion-api.md)
 */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  const startedAt = Date.now();
  try {
    const env = serverEnv();
    const db = adminDb();

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > LIMITS.maxRequestBytes) {
      throw new ApiError(
        413,
        "payload_too_large",
        `Request body exceeds ${LIMITS.maxRequestBytes} bytes.`,
      );
    }

    const { projectId, keyId } = await authenticateApiKey(
      db,
      request.headers.get("authorization"),
      env.keyPepper,
    );

    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > LIMITS.maxRequestBytes) {
      throw new ApiError(
        413,
        "payload_too_large",
        `Request body exceeds ${LIMITS.maxRequestBytes} bytes.`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }

    const normalized = normalizeIngestBody(body);
    if (!normalized.ok) {
      const status = normalized.error.code === "payload_too_large" ? 413 : 400;
      throw new ApiError(status, normalized.error.code, normalized.error.message);
    }

    const outcome = await ingestTrace(db, projectId, normalized.value);
    log("info", "ingest.stored", {
      requestId,
      projectId,
      keyId,
      traceId: normalized.value.trace.id,
      spanCount: normalized.value.spans.length,
      estimatedBytes: normalized.value.estimatedBytes,
      duplicate: outcome.duplicate,
      ms: Date.now() - startedAt,
    });
    return jsonResponse(
      {
        ok: true,
        traceId: normalized.value.trace.id,
        projectId,
        spanCount: normalized.value.spans.length,
        duplicate: outcome.duplicate,
        requestId,
      },
      outcome.created ? 201 : 200,
      requestId,
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", "ingest.not_configured", { requestId, problems: err.problems });
      return errorResponse(
        500,
        "not_configured",
        "Ingestion is not configured on this deployment.",
        requestId,
      );
    }
    if (err instanceof ApiError) {
      if (err.status >= 500 || err.status === 429)
        log("warn", "ingest.rejected", { requestId, code: err.code, status: err.status });
    } else {
      log("error", "ingest.failed", { requestId, error: err });
    }
    return errorToResponse(err, requestId, false);
  }
}

export async function GET() {
  const requestId = newRequestId();
  return errorResponse(405, "invalid_request", "Use POST with a JSON trace body.", requestId);
}
