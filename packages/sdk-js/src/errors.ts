/** Error raised (or reported) by the FireTrace clients. */
export class FireTraceError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  constructor(
    message: string,
    opts: {
      status?: number | null;
      code?: string;
      requestId?: string | null;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "FireTraceError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? "unknown";
    this.requestId = opts.requestId ?? null;
    this.retryable = opts.retryable ?? false;
  }
}
