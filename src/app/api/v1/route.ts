import { newRequestId } from "@/lib/firetrace/ids";
import { jsonResponse } from "@/lib/firetrace/errors";

export const runtime = "nodejs";

/** Public index of the API surface. */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return jsonResponse(
    {
      name: "FireTrace API",
      version: "1",
      openapi: `${origin}/api/v1/openapi.json`,
      docs: "https://github.com/IdkwhatImD0ing/FireTrace/blob/main/docs/api.md",
      mcp: `${origin}/api/mcp`,
      endpoints: {
        recordTrace: "POST /api/v1/traces",
        listTraces: "GET /api/v1/traces",
        getTrace: "GET /api/v1/traces/{traceId}",
        patchTraceMetadata: "PATCH /api/v1/traces/{traceId}",
        deleteTrace: "DELETE /api/v1/traces/{traceId}",
        getProject: "GET /api/v1/project",
      },
      auth: "Authorization: Bearer ft_live_<keyId>_<secret>",
    },
    200,
    newRequestId(),
  );
}
