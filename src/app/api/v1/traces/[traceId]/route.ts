import { withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { isTraceId } from "@/lib/firetrace/ids";
import { normalizeMetadataPatch, patchTraceMetadata } from "@/lib/firetrace/metadata";
import { deleteTrace } from "@/lib/firetrace/projects";
import { getTrace, listSpans } from "@/lib/firetrace/queries";
import { LIMITS } from "@/lib/firetrace/schema";
import { log } from "@/lib/log";

export const runtime = "nodejs";

function traceIdParam(params: Record<string, string>): string {
  const traceId = (params.traceId ?? "").toLowerCase();
  if (!isTraceId(traceId)) throw new ApiError(404, "not_found", "No such trace in this project.");
  return traceId;
}

/** GET /api/v1/traces/{traceId} — one trace with all spans. */
export const GET = withApiKey("traces:read", async ({ db, auth, requestId, params }) => {
  const traceId = traceIdParam(params);
  const trace = await getTrace(db, auth.projectId, traceId);
  if (!trace) throw new ApiError(404, "not_found", "No such trace in this project.");
  const spans = await listSpans(db, auth.projectId, traceId);
  return jsonResponse({ trace, spans }, 200, requestId);
});

/**
 * PATCH /api/v1/traces/{traceId} — shallow-merge keys into the trace's
 * metadata (scope traces:write). Body: { "metadata": { ... } }. This is the
 * only mutable part of a stored trace; see docs/ingestion-api.md.
 */
export const PATCH = withApiKey(
  "traces:write",
  async ({ db, auth, requestId, params }, request) => {
    const traceId = traceIdParam(params);
    const tooLarge = () =>
      new ApiError(
        413,
        "payload_too_large",
        `Request body exceeds ${LIMITS.maxRequestBytes} bytes.`,
      );
    if (Number(request.headers.get("content-length") ?? "0") > LIMITS.maxRequestBytes) {
      throw tooLarge();
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > LIMITS.maxRequestBytes) throw tooLarge();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }

    const normalized = normalizeMetadataPatch(body);
    if (!normalized.ok) {
      throw new ApiError(400, normalized.error.code, normalized.error.message);
    }

    const outcome = await patchTraceMetadata(db, auth.projectId, traceId, normalized.value);
    log("info", "trace.metadata_patched", {
      requestId,
      projectId: auth.projectId,
      keyId: auth.keyId,
      traceId,
      patchedKeys: Object.keys(normalized.value).length,
      changed: outcome.changed,
    });
    return jsonResponse(
      { ok: true, traceId, metadata: outcome.metadata, changed: outcome.changed, requestId },
      200,
      requestId,
    );
  },
);

/** DELETE /api/v1/traces/{traceId} — explicit deletion of one trace and its spans. */
export const DELETE = withApiKey("traces:delete", async ({ db, auth, requestId, params }) => {
  const traceId = traceIdParam(params);
  await deleteTrace(db, auth.projectId, traceId).catch((err) => {
    if (err instanceof ApiError && err.status === 404) {
      throw new ApiError(404, "not_found", "No such trace in this project.");
    }
    throw err;
  });
  return jsonResponse({ ok: true, traceId }, 200, requestId);
});
