import { intParam, readJsonBody, withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { ingestTrace } from "@/lib/firetrace/ingest";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import {
  DEFAULT_PAGE_SIZE,
  listTraces,
  MAX_PAGE_SIZE,
  parseTraceFilters,
  parseTraceSort,
} from "@/lib/firetrace/queries";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/v1/traces — store one complete, immutable trace.
 *   Authorization: Bearer ft_live_<keyId>_<secret>   (scope traces:write)
 *   Body: { schemaVersion: 1, trace: {...} }  (see docs/api.md)
 */
export const POST = withApiKey("traces:write", async ({ db, env, auth, requestId }, request) => {
  const startedAt = Date.now();
  const body = await readJsonBody(request);
  const normalized = normalizeIngestBody(body);
  if (!normalized.ok) {
    const status = normalized.error.code === "payload_too_large" ? 413 : 400;
    throw new ApiError(status, normalized.error.code, normalized.error.message);
  }

  const outcome = await ingestTrace(db, auth.projectId, normalized.value, {
    trialTraceLimit: env.trialTraceLimit,
    repositoryUrl: env.repositoryUrl,
    allowedEmails: env.allowedEmails,
  });
  log("info", "ingest.stored", {
    requestId,
    projectId: auth.projectId,
    keyId: auth.keyId,
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
      projectId: auth.projectId,
      spanCount: normalized.value.spans.length,
      duplicate: outcome.duplicate,
      requestId,
    },
    outcome.created ? 201 : 200,
    requestId,
  );
});

/**
 * GET /api/v1/traces — newest-first, cursor-paginated list (scope traces:read).
 *   ?status=&model=&name=&tag=&sessionId=&userId=&from=&to=&sort=&limit=&after=&before=
 */
export const GET = withApiKey("traces:read", async ({ db, auth, requestId }, request) => {
  const sp = request.nextUrl.searchParams;
  const filters = parseTraceFilters(Object.fromEntries(sp.entries()));
  const page = await listTraces(db, auth.projectId, filters, {
    after: sp.get("after") ?? undefined,
    before: sp.get("before") ?? undefined,
    limit: intParam(sp.get("limit"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    sort: parseTraceSort(sp.get("sort")),
  });
  return jsonResponse(page, 200, requestId);
});
