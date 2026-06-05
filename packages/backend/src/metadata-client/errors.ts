/**
 * Error types surfaced by {@link MetadataClient}. Callers can branch on these instead of parsing
 * status codes or message strings.
 *
 *  - {@link MetadataError}      — base: any non-2xx response (carries `status` + the parsed
 *                                 `code`/`error` from the server's `ApiError` envelope when present).
 *  - {@link MetadataAuthError}  — a 401 (bad/missing token or project id). A distinct subclass so the
 *                                 setup wizard / pairing flow can react specifically to auth failure.
 *  - {@link MetadataValidationError} — a 2xx response whose JSON FAILED the shared zod DTO. This is a
 *                                 contract mismatch (the server returned something unexpected), kept
 *                                 separate from a transport/HTTP error.
 */

/** Base error for any failed metadata-service interaction. */
export class MetadataError extends Error {
  /** HTTP status code, or 0 for a transport/network failure before a response arrived. */
  readonly status: number;
  /** The `code` from the server's `ApiError` envelope, if one was returned. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'MetadataError';
    this.status = status;
    this.code = code;
  }
}

/** A 401 from the metadata service: missing/invalid bearer token or project id. */
export class MetadataAuthError extends MetadataError {
  constructor(message = 'metadata service rejected the credentials', code?: string) {
    super(message, 401, code);
    this.name = 'MetadataAuthError';
  }
}

/**
 * A successful (2xx) response whose body did NOT match the shared zod DTO. Signals a
 * client/server contract drift rather than an HTTP error. `status` is the (2xx) status received.
 */
export class MetadataValidationError extends MetadataError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = 'MetadataValidationError';
  }
}
