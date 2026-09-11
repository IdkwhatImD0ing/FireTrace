import { readJsonBody, traceIdParam, withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { normalizeEndBody } from "@/lib/firetrace/normalize";
import { endTrace } from "@/lib/firetrace/stream";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/v1/traces/{traceId}/end — close a running trace (scope
 * traces:write). Body: { schemaVersion: 1, endedAt, status?, output?, ... }.
 * See docs/ingestion-api.md, "Streaming a trace".
 */
export const POST = withApiKey("traces:write", async ({ db, auth, requestId, params }, request) => {
  const traceId = traceIdParam(params);
  const body = await readJsonBody(request);
  const normalized = normalizeEndBody(body, traceId);
  if (!normalized.ok) {
    const status = normalized.error.code === "payload_too_large" ? 413 : 400;
    throw new ApiError(status, normalized.error.code, normalized.error.message);
  }
  const outcome = await endTrace(db, auth.projectId, traceId, normalized.value);
  log("info", "ingest.ended", {
    requestId,
    projectId: auth.projectId,
    keyId: auth.keyId,
    traceId,
    status: normalized.value.status,
    spanCount: outcome.spanCount,
    duplicate: outcome.duplicate,
  });
  return jsonResponse({ ok: true, traceId, ...outcome, requestId }, 200, requestId);
});
