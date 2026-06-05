/**
 * Shared HTTP plumbing: the Hono environment type, the uniform error envelope, and a body parser
 * that validates against a shared zod schema.
 *
 * PRIVACY (Golden rule #3): {@link parseBody} validates EVERY request body with the corresponding
 * `@mailordomo/shared` `strictObject` schema. Strict objects reject any undeclared key, so a body
 * smuggling an email/draft body (or any unknown field) fails here with 400 before it can be stored.
 */
import type { Context } from 'hono';
import type { ApiError, AuthedProject } from '@mailordomo/shared';

/** Hono per-request variables. `project` is set by the bearer-auth middleware once authenticated. */
export type AppEnv = { Variables: { project: AuthedProject } };

/** The status codes this service emits for error envelopes. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

/**
 * Minimal structural view of a zod schema's `safeParse`. Declaring it structurally lets routes pass
 * shared zod schemas without the server taking a direct dependency on zod.
 */
export interface Parser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/** Send a uniform {@link ApiError} envelope with the given status. */
export function jsonError(
  c: Context<AppEnv>,
  status: ErrorStatus,
  error: string,
  code?: string,
): Response {
  const body: ApiError = code === undefined ? { error } : { error, code };
  return c.json(body, status);
}

/** Parsed-body result: either the validated payload or a ready-to-return error response. */
export type ParsedBody<T> = { ok: true; data: T } | { ok: false; res: Response };

/**
 * Read and validate a JSON request body against `schema`. An empty body is treated as `{}` so
 * empty-but-strict payloads (e.g. the learning-revert request) validate, while endpoints with
 * required fields still fail validation on an empty body.
 */
export async function parseBody<T>(c: Context<AppEnv>, schema: Parser<T>): Promise<ParsedBody<T>> {
  const text = await c.req.text();
  let raw: unknown;
  if (text.trim() === '') {
    raw = {};
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: jsonError(c, 400, 'invalid json body', 'invalid_json') };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: jsonError(c, 400, 'request failed validation', 'validation') };
  }
  return { ok: true, data: parsed.data };
}
