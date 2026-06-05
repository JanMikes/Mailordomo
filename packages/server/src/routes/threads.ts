/**
 * Threads — upsert the sanctioned shared fields (subject / snippet / sender) and read them back.
 * Scoped to the authenticated project; a body `project_id` that disagrees with the token is 403.
 */
import { Hono } from 'hono';
import { UpsertThreadRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function threadRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, UpsertThreadRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    if (parsed.data.project_id !== project.id) {
      return jsonError(c, 403, 'project_id does not match the authenticated project', 'forbidden');
    }
    return c.json(repo.upsertThread(project.id, parsed.data, nowIso()), 200);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listThreads(project.id), 200);
  });

  app.get('/:id', (c) => {
    const project = c.get('project');
    const thread = repo.getThread(project.id, c.req.param('id'));
    if (thread === undefined) return jsonError(c, 404, 'thread not found', 'not_found');
    return c.json(thread, 200);
  });

  return app;
}
