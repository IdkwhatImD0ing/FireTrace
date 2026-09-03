import "server-only";
import { serverEnv } from "@/lib/env/server";
import { ApiError } from "@/lib/firetrace/errors";

/**
 * Cookie-authenticated mutations must come from our own origin. Accepts the
 * canonical NEXT_PUBLIC_APP_URL origin and the request's own Host (so Vercel
 * preview URLs work). A missing Origin header is rejected.
 */
export function allowedOrigins(request: Request): Set<string> {
  const origins = new Set<string>([serverEnv().appUrl]);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    origins.add(`${proto}://${host}`);
  }
  return origins;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(request).has(origin)) {
    throw new ApiError(403, "forbidden", "Cross-origin request rejected.");
  }
}
