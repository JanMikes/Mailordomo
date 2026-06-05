/**
 * Draft metadata — METADATA ONLY (model / author / version / timestamp). The strict DTO has no body
 * field, so a draft body cannot be posted; the draft text stays on the local machine (Golden #3).
 */
import { Hono } from 'hono';
import { CreateDraftMetaRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function draftRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreateDraftMetaRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const draft = repo.createDraftMeta(project.id, parsed.data, nowIso());
    if (draft === undefined) return jsonError(c, 404, 'thread not found', 'not_found');
    return c.json(draft, 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listDraftMeta(project.id, c.req.query('thread_id')), 200);
  });

  return app;
}
