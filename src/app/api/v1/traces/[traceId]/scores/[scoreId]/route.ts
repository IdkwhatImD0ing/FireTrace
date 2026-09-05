import { traceIdParam, withApiKey } from "@/lib/firetrace/api-handler";
import { jsonResponse } from "@/lib/firetrace/errors";
import { deleteScore } from "@/lib/firetrace/scores";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/** DELETE /api/v1/traces/{traceId}/scores/{scoreId} — remove one score (scope traces:delete). */
export const DELETE = withApiKey("traces:delete", async ({ db, auth, requestId, params }) => {
  const traceId = traceIdParam(params);
  const scoreId = (params.scoreId ?? "").toLowerCase();
  await deleteScore(db, auth.projectId, traceId, scoreId);
  log("info", "score.deleted", {
    requestId,
    projectId: auth.projectId,
    keyId: auth.keyId,
    traceId,
    scoreId,
  });
  return jsonResponse({ ok: true, traceId, scoreId }, 200, requestId);
});
