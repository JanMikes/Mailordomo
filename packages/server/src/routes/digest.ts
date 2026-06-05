/**
 * Digest metadata — the server supplies METADATA ONLY (subject/snippet/sender + actor-attributed
 * transitions + draft metadata + promises due) for a time window; the local app synthesizes the
 * actual prose (PLAN.md §9 #11). Body-free by construction (the read model is strict + sanctioned
 * fields only).
 */
import { Hono } from 'hono';
import { DigestMetadataRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function digestRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, DigestMetadataRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    if (parsed.data.project_id !== project.id) {
      return jsonError(c, 403, 'project_id does not match the authenticated project', 'forbidden');
    }
    return c.json(repo.getDigestMetadata(project.id, parsed.data, nowIso()), 200);
  });

  return app;
}
