/** Promises — the 3-way tracker. Create, list (optionally per thread), and PATCH (the reconciler). */
import { Hono } from 'hono';
import { CreatePromiseRequestSchema, UpdatePromiseRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function promiseRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreatePromiseRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const promise = repo.createPromise(project.id, parsed.data, nowIso());
    if (promise === undefined) return jsonError(c, 404, 'thread not found', 'not_found');
    return c.json(promise, 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listPromises(project.id, c.req.query('thread_id')), 200);
  });

  app.patch('/:id', async (c) => {
    const parsed = await parseBody(c, UpdatePromiseRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const promise = repo.updatePromise(project.id, c.req.param('id'), parsed.data);
    if (promise === undefined) return jsonError(c, 404, 'promise not found', 'not_found');
    return c.json(promise, 200);
  });

  return app;
}
