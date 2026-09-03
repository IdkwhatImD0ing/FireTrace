import { configStatus } from "@/lib/env/server";
import { jsonResponse } from "@/lib/firetrace/errors";
import { newRequestId } from "@/lib/firetrace/ids";

export const runtime = "nodejs";

/** Booleans only. Never exposes configuration values. */
export async function GET() {
  const status = configStatus();
  const body = {
    ok: status.firebaseConfigured && status.authConfigured && status.ingestConfigured,
    firebaseConfigured: status.firebaseConfigured,
    authConfigured: status.authConfigured,
    ingestConfigured: status.ingestConfigured,
    emulators: status.emulators,
    ...(process.env.NODE_ENV !== "production" ? { problems: status.problems } : {}),
  };
  return jsonResponse(body, 200, newRequestId());
}
