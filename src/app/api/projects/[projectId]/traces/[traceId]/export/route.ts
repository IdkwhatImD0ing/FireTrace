import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth/session";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError, errorToResponse, NO_STORE_HEADERS } from "@/lib/firetrace/errors";
import { canonicalJson } from "@/lib/firetrace/hash";
import { newRequestId } from "@/lib/firetrace/ids";
import { isProjectId } from "@/lib/firetrace/ids";
import { getTrace, listSpans } from "@/lib/firetrace/queries";
import type { JsonValue } from "@/lib/firetrace/schema";

export const runtime = "nodejs";

/** GET -> download one trace (with spans) as canonical JSON. Owner only. */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/projects/[projectId]/traces/[traceId]/export">,
) {
  const requestId = newRequestId();
  try {
    await requireOwner();
    const { projectId, traceId } = await ctx.params;
    if (!isProjectId(projectId)) throw new ApiError(404, "not_found", "Project not found.");
    const db = adminDb();
    const trace = await getTrace(db, projectId, traceId);
    if (!trace) throw new ApiError(404, "not_found", "Trace not found.");
    const spans = await listSpans(db, projectId, traceId);
    const document = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      projectId,
      trace: { ...trace, spans },
    } as unknown as JsonValue;
    return new Response(canonicalJson(document), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="firetrace-${traceId}.json"`,
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    return errorToResponse(err, requestId, process.env.NODE_ENV !== "production");
  }
}
