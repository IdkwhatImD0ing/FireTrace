import { withApiKey } from "@/lib/firetrace/api-handler";
import { ApiError, jsonResponse } from "@/lib/firetrace/errors";
import { requireProject } from "@/lib/firetrace/projects";
import { storageLevel } from "@/lib/firetrace/storage";

export const runtime = "nodejs";

/** GET /api/v1/project — the key's project with counters and storage estimate. */
export const GET = withApiKey("traces:read", async ({ db, env, auth, requestId }) => {
  const project = await requireProject(db, auth.projectId).catch(() => {
    throw new ApiError(401, "invalid_api_key", "The project for this API key no longer exists.");
  });
  return jsonResponse(
    {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      traceCount: project.traceCount,
      spanCount: project.spanCount,
      estimatedBytes: project.estimatedBytes,
      lastTraceAt: project.lastTraceAt,
      createdAt: project.createdAt,
      storage: {
        limitBytes: env.storageLimitBytes,
        level: storageLevel(project.estimatedBytes, env.storageLimitBytes),
      },
      keyScopes: auth.scopes,
    },
    200,
    requestId,
  );
});
