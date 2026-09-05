import { withApiKey } from "@/lib/firetrace/api-handler";
import { jsonResponse } from "@/lib/firetrace/errors";

export const runtime = "nodejs";

/**
 * GET /api/v1/key — describe the calling key (no scope required). Lets a
 * client verify a key and learn which scopes it carries and which
 * environment its traces land in before doing work.
 */
export const GET = withApiKey(null, async ({ auth, requestId }) => {
  return jsonResponse(
    {
      keyId: auth.keyId,
      projectId: auth.projectId,
      scopes: auth.scopes,
      expiresAt: auth.expiresAt ? auth.expiresAt.toISOString() : null,
      lastUsedAt: auth.lastUsedAt ? auth.lastUsedAt.toISOString() : null,
      environment: auth.environment,
    },
    200,
    requestId,
  );
});
