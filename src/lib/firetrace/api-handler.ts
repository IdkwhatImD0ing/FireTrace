import type { Firestore } from "firebase-admin/firestore";
import type { NextRequest, NextResponse } from "next/server";
import { ConfigError, serverEnv, type ServerEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { log } from "@/lib/log";
import {
  authenticateApiKey,
  requireScope,
  requireTrialModeForKey,
  touchApiKey,
  type AuthenticatedKey,
} from "./api-auth";
import { ApiError, errorResponse, errorToResponse } from "./errors";
import { newRequestId } from "./ids";
import type { KeyScope } from "./scopes";

export interface ApiContext {
  db: Firestore;
  env: ServerEnv;
  auth: AuthenticatedKey;
  requestId: string;
  /** Resolved dynamic route params. */
  params: Record<string, string>;
}

type Handler = (ctx: ApiContext, request: NextRequest) => Promise<NextResponse | Response>;

function withAuthChallenge(res: Response): Response {
  if (res.status === 401 && !res.headers.has("WWW-Authenticate")) {
    res.headers.set("WWW-Authenticate", 'Bearer realm="firetrace", error="invalid_token"');
  }
  return res;
}

/**
 * Wrap a key-authenticated route handler: config check, bearer auth, scope
 * check, error envelope, request id, and `Cache-Control: no-store`.
 */
export function withApiKey(scope: KeyScope | null, handler: Handler) {
  return async (
    request: NextRequest,
    ctx?: { params: Promise<Record<string, string>> },
  ): Promise<Response> => {
    const requestId = newRequestId();
    try {
      const env = serverEnv();
      const db = adminDb();
      const auth = await authenticateApiKey(
        db,
        request.headers.get("authorization"),
        env.keyPepper,
      );
      requireTrialModeForKey(auth, env.trialTraceLimit);
      if (scope) requireScope(auth, scope);
      const params = ctx ? await ctx.params : {};
      const response = await handler({ db, env, auth, requestId, params }, request);
      void touchApiKey(db, auth);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Request-Id", requestId);
      return response;
    } catch (err) {
      if (err instanceof ConfigError) {
        log("error", "api.not_configured", { requestId, problems: err.problems });
        return errorResponse(
          500,
          "not_configured",
          "This deployment is not configured.",
          requestId,
        );
      }
      if (!(err instanceof ApiError)) log("error", "api.failed", { requestId, error: err });
      else if (err.status >= 500 || err.status === 429) {
        log("warn", "api.rejected", { requestId, code: err.code, status: err.status });
      }
      return withAuthChallenge(errorToResponse(err, requestId, false));
    }
  };
}

/** Parse a positive integer query value with bounds. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new ApiError(400, "invalid_request", `Expected an integer, got "${value}".`);
  }
  return Math.min(Math.max(n, min), max);
}
