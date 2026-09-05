import { intParam, requireKnownParams, withApiKey } from "@/lib/firetrace/api-handler";
import { jsonResponse } from "@/lib/firetrace/errors";
import {
  DEFAULT_SCORE_PAGE_SIZE,
  listScores,
  MAX_SCORE_PAGE_SIZE,
  parseScoreFilters,
  SCORE_LIST_PARAMS,
} from "@/lib/firetrace/scores";

export const runtime = "nodejs";

/**
 * GET /api/v1/scores — newest-first, cursor-paginated scores across the
 * project (scope traces:read). ?name=&environment=&from=&to=&limit=&after=
 * An unknown parameter or value is a 400 naming it.
 */
export const GET = withApiKey("traces:read", async ({ db, auth, requestId }, request) => {
  const sp = request.nextUrl.searchParams;
  requireKnownParams(sp, SCORE_LIST_PARAMS);
  const filters = parseScoreFilters(Object.fromEntries(sp.entries()), { strict: true });
  const page = await listScores(db, auth.projectId, filters, {
    after: sp.get("after") ?? undefined,
    limit: intParam(sp.get("limit"), DEFAULT_SCORE_PAGE_SIZE, 1, MAX_SCORE_PAGE_SIZE),
  });
  return jsonResponse(page, 200, requestId);
});
