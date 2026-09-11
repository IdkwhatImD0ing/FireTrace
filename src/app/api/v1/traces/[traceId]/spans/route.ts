import { readJsonBody, traceIdParam, withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { normalizeSpansBody } from "@/lib/firetrace/normalize";
import { appendSpans } from "@/lib/firetrace/stream";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/v1/traces/{traceId}/spans — append finished spans to a running
 * trace (scope traces:write). Body: { schemaVersion: 1, spans: [...] }.
 * See docs/ingestion-api.md, "Streaming a trace".
 */
export const POST = withApiKey("traces:write", async ({ db, auth, requestId, params }, request) => {
  const traceId = traceIdParam(params);
  const body = await readJsonBody(request);
  const normalized = normalizeSpansBody(body, traceId);
  if (!normalized.ok) {
    const status = normalized.error.code === "payload_too_large" ? 413 : 400;
    throw new ApiError(status, normalized.error.code, normalized.error.message);
  }
  const outcome = await appendSpans(db, auth.projectId, traceId, normalized.value);
  log("info", "ingest.spans_appended", {
    requestId,
    projectId: auth.projectId,
    keyId: auth.keyId,
    traceId,
    added: outcome.added,
    duplicate: outcome.duplicate,
    spanCount: outcome.spanCount,
  });
  return jsonResponse({ ok: true, traceId, ...outcome, requestId }, 200, requestId);
});
