import { NextResponse } from "next/server";

/**
 * Stable API error envelope:
 *   { "error": { "code": "...", "message": "...", "requestId": "..." } }
 */
export type ApiErrorCode =
  | "invalid_json"
  | "invalid_trace"
  | "invalid_request"
  | "invalid_api_key"
  | "unauthorized"
  | "forbidden"
  | "insufficient_scope"
  | "not_found"
  | "trace_id_conflict"
  | "conflict"
  | "payload_too_large"
  | "quota_exhausted"
  | "trial_limit_reached"
  | "rate_limited"
  | "not_configured"
  | "internal_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function jsonResponse(body: unknown, status: number, requestId: string): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, "X-Request-Id": requestId },
  });
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
): NextResponse {
  return jsonResponse({ error: { code, message, requestId } }, status, requestId);
}

/** Map a thrown value to a response without leaking internals. */
export function errorToResponse(
  err: unknown,
  requestId: string,
  exposeDetails: boolean,
): NextResponse {
  if (err instanceof ApiError) {
    return errorResponse(err.status, err.code, err.message, requestId);
  }
  const message =
    exposeDetails && err instanceof Error
      ? `Unexpected error: ${err.message}`
      : "Unexpected server error. Check the server logs for this request id.";
  return errorResponse(500, "internal_error", message, requestId);
}

/** Firestore reports exhausted quota as gRPC code 8 (RESOURCE_EXHAUSTED). */
export function isQuotaExhausted(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 8 || code === "resource-exhausted" || code === "RESOURCE_EXHAUSTED";
}
