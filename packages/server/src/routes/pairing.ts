/**
 * Pairing — the ONLY public data endpoint. A local app posts `{ project_id, token }`; the server
 * hashes the token and constant-time compares it to the stored `token_hash`. On success it echoes
 * the client-safe project (identity only, never the hash). This endpoint is mounted BEFORE the
 * bearer-auth middleware (it is the credential check itself).
 *
 * WARNING: every route in this router is UNAUTHENTICATED (mounted before the bearer guard). Do NOT
 * add any non-public route here — authenticated routes belong in their own router after the guard.
 */
import { Hono } from 'hono';
import type { PairResponse } from '@mailordomo/shared';
import { PairRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { toAuthedProject, verifyProjectToken } from '../auth';
import type { Repository } from '../repo/repository';

export function pairingRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/pair', async (c) => {
    const parsed = await parseBody(c, PairRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = repo.getProjectById(parsed.data.project_id);
    if (project === undefined || !verifyProjectToken(project, parsed.data.token)) {
      return jsonError(c, 401, 'invalid project id or token', 'unauthorized');
    }
    const body: PairResponse = { project: toAuthedProject(project) };
    return c.json(body, 200);
  });

  return app;
}
