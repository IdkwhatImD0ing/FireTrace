import { withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { isTraceId } from "@/lib/firetrace/ids";
import { deleteTrace } from "@/lib/firetrace/projects";
import { getTrace, listSpans } from "@/lib/firetrace/queries";

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
