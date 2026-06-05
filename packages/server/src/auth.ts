/**
 * Bearer-token auth & pairing (PROJECT.md §3 Layer 2; Golden rule #4; PLAN.md open Q #17).
 *
 * A `Project` stores only a `token_hash` — the sha256 of the shared secret, NEVER the plaintext.
 * A request authenticates by presenting the plaintext token as `Authorization: Bearer <token>`
 * together with `X-Project-Id`. We hash the presented token and compare it to the stored hash with
 * a CONSTANT-TIME comparison (`crypto.timingSafeEqual`) so a bad token cannot be recovered by
 * timing the response. All data endpoints are then scoped to the authenticated project.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AuthedProject, Project } from '@mailordomo/shared';
import type { Repository } from './repo/repository';
import type { AppEnv } from './http';
import { jsonError } from './http';

/** Header carrying the project id alongside the bearer token. */
export const PROJECT_ID_HEADER = 'x-project-id';

/** sha256 hex digest of a token. Stored as `Project.token_hash`; never reversible to the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two sha256 hex digests. `timingSafeEqual` throws on unequal-length
 * buffers, so we guard length first (sha256 hex is always 64 chars / 32 bytes — a length mismatch
 * means a malformed/garbage value, not a match).
 */
export function safeTokenEqual(presentedHashHex: string, storedHashHex: string): boolean {
  if (presentedHashHex.length !== storedHashHex.length) return false;
  const presented = Buffer.from(presentedHashHex, 'hex');
  const stored = Buffer.from(storedHashHex, 'hex');
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/** Verify a plaintext token against a project's stored hash (constant time). */
export function verifyProjectToken(project: Project, token: string): boolean {
  return safeTokenEqual(hashToken(token), project.token_hash);
}

/** Strip the secret: the client-safe view of a project (identity only, never `token_hash`). */
export function toAuthedProject(project: Project): AuthedProject {
  return { id: project.id, name: project.name };
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Middleware enforcing bearer auth on every route it guards. On success it sets `project` (the
 * client-safe view) for downstream handlers to scope by; otherwise it short-circuits with 401.
 */
export function bearerAuth(repo: Repository): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    const projectId = c.req.header(PROJECT_ID_HEADER);
    if (authorization === undefined || projectId === undefined) {
      return jsonError(c, 401, 'missing project id or bearer token', 'unauthorized');
    }
    const match = BEARER_RE.exec(authorization);
    const token = match?.[1];
    if (token === undefined) {
      return jsonError(c, 401, 'malformed authorization header', 'unauthorized');
    }
    const project = repo.getProjectById(projectId);
    if (project === undefined || !verifyProjectToken(project, token)) {
      return jsonError(c, 401, 'invalid project id or token', 'unauthorized');
    }
    c.set('project', toAuthedProject(project));
    await next();
  };
}
