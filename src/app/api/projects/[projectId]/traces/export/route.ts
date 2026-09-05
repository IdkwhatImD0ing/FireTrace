import type { NextRequest } from "next/server";
import { requireAccessibleProject } from "@/lib/auth/access";
import { requireOwner } from "@/lib/auth/session";
import { getEnvironmentView } from "@/lib/environment-selection";
import { adminDb } from "@/lib/firebase/admin";
import { toCsv, type CsvValue } from "@/lib/firetrace/csv";
import { ApiError, errorToResponse, NO_STORE_HEADERS } from "@/lib/firetrace/errors";
import { isProjectId, newRequestId } from "@/lib/firetrace/ids";
import { listTraces, parseTraceFilters, parseTraceSort } from "@/lib/firetrace/queries";
import { formatScoreValue } from "@/lib/format";

export const runtime = "nodejs";

const COLUMNS = [
  "id",
  "name",
  "status",
  "environment",
  "startedAt",
  "endedAt",
  "durationMs",
  "provider",
  "model",
  "sessionId",
  "userId",
  "tags",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "costUsd",
  "spanCount",
  "errorCount",
  "scores",
  "estimatedBytes",
  "ingestedAt",
] as const;

/**
 * GET -> the page of traces the dashboard is showing, as CSV. Owner only.
 * Takes the same query string as the trace list (filters, sort, after/before)
 * and the environment from the selector's cookie, so it matches the screen.
 */
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/projects/[projectId]/traces/export">,
) {
  const requestId = newRequestId();
  try {
    const owner = await requireOwner();
    const { projectId } = await ctx.params;
    if (!isProjectId(projectId)) throw new ApiError(404, "not_found", "Project not found.");
    const db = adminDb();
    await requireAccessibleProject(db, owner, projectId);
    const sp = request.nextUrl.searchParams;
    const view = await getEnvironmentView(db, projectId);
    const page = await listTraces(
      db,
      projectId,
      { ...parseTraceFilters(Object.fromEntries(sp)), environment: view.filter },
      {
        after: sp.get("after") ?? undefined,
        before: sp.get("before") ?? undefined,
        sort: parseTraceSort(sp.get("sort")),
      },
    );
    const rows: CsvValue[][] = page.traces.map((t) => [
      t.id,
      t.name,
      t.status,
      t.environment,
      t.startedAt,
      t.endedAt,
      t.durationMs,
      t.provider,
      t.model,
      t.sessionId,
      t.userId,
      t.tags.join("|"),
      t.usage.inputTokens ?? null,
      t.usage.outputTokens ?? null,
      t.usage.totalTokens ?? null,
      t.costUsd,
      t.spanCount,
      t.errorCount,
      Object.entries(t.scores)
        .map(([name, s]) => `${name}=${formatScoreValue(s.value)}`)
        .join("|"),
      t.estimatedBytes,
      t.ingestedAt,
    ]);
    return new Response(toCsv(COLUMNS, rows), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="firetrace-${projectId}-traces.csv"`,
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    return errorToResponse(err, requestId, false);
  }
}
