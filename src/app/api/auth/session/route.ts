import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { assertSameOrigin } from "@/lib/auth/origin";
import { createSessionCookie, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { ConfigError, serverEnv } from "@/lib/env/server";
import { ApiError, errorResponse, errorToResponse, jsonResponse } from "@/lib/firetrace/errors";
import { newRequestId } from "@/lib/firetrace/ids";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/** POST { idToken } -> sets the session cookie after allowlist verification. */
export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const env = serverEnv();
    assertSameOrigin(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be JSON.");
    }
    const idToken = (body as { idToken?: unknown })?.idToken;
    if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) {
      throw new ApiError(400, "invalid_request", "idToken is required.");
    }
    const { cookie, owner } = await createSessionCookie(idToken);
    const store = await cookies();
    store.set(SESSION_COOKIE, cookie, sessionCookieOptions(env));
    log("info", "session.created", { requestId, uid: owner.uid });
    return jsonResponse({ ok: true, email: owner.email }, 200, requestId);
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", "session.not_configured", { requestId, problems: err.problems });
      return errorResponse(
        500,
        "not_configured",
        process.env.NODE_ENV === "production"
          ? "The dashboard is not configured. Check the server environment variables."
          : err.message,
        requestId,
      );
    }
    if (!(err instanceof ApiError)) log("error", "session.failed", { requestId, error: err });
    return errorToResponse(err, requestId, process.env.NODE_ENV !== "production");
  }
}

/** DELETE -> clears the session cookie (logout). */
export async function DELETE(request: NextRequest) {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return jsonResponse({ ok: true }, 200, requestId);
  } catch (err) {
    return errorToResponse(err, requestId, process.env.NODE_ENV !== "production");
  }
}
