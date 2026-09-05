import { readJsonBody, traceIdParam, withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { getTrace } from "@/lib/firetrace/queries";
import { addScore, listScoresForTrace, normalizeScoreInput } from "@/lib/firetrace/scores";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/v1/traces/{traceId}/scores — attach one score to a stored trace
 * (scope traces:write). Body: { name, dataType, value, comment?, spanId? }.
 * Scores are append-only; a repeated name adds a newer score rather than
 * overwriting, and the trace keeps the newest one per name as its summary.
 */
export const POST = withApiKey("traces:write", async ({ db, auth, requestId, params }, request) => {
  const traceId = traceIdParam(params);
  const normalized = normalizeScoreInput(await readJsonBody(request));
  if (!normalized.ok) {
    throw new ApiError(400, normalized.error.code, normalized.error.message);
  }
  const score = await addScore(db, auth.projectId, traceId, normalized.value, { source: "api" });
  log("info", "score.added", {
    requestId,
    projectId: auth.projectId,
    keyId: auth.keyId,
    traceId,
    scoreId: score.id,
    name: score.name,
    dataType: score.dataType,
    source: score.source,
  });
  return jsonResponse({ ok: true, score, requestId }, 201, requestId);
});

/** GET /api/v1/traces/{traceId}/scores — every score of one trace, newest first. */
export const GET = withApiKey("traces:read", async ({ db, auth, requestId, params }) => {
  const traceId = traceIdParam(params);
  const trace = await getTrace(db, auth.projectId, traceId);
  if (!trace) throw new ApiError(404, "not_found", "No such trace in this project.");
  const scores = await listScoresForTrace(db, auth.projectId, traceId);
  return jsonResponse({ traceId, scores }, 200, requestId);
});
