/**
 * Windowed, project-wide task transitions — the body-free "what was handled" read for the morning
 * digest (PLAN.md D34). `GET /transitions?window_start=<iso>&window_end=<iso>` returns every
 * actor-attributed transition in the window (newest first), each with its thread's subject and NO
 * body. The local app consumes this for the digest's "what Simona handled" section, which is built
 * PURELY from actor attribution on server metadata (Golden rule #3 — never her message body).
 *
 * This is a separate top-level resource (not `/tasks/transitions`, which would collide with
 * `/tasks/:id`). Project-scoped like every other data route (the auth middleware wraps it).
 */
import { Hono } from 'hono';
import { IsoDateTimeSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError } from '../http';
import type { Repository } from '../repo/repository';

export function transitionRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => {
    const startParsed = IsoDateTimeSchema.safeParse(c.req.query('window_start'));
    const endParsed = IsoDateTimeSchema.safeParse(c.req.query('window_end'));
    if (!startParsed.success || !endParsed.success) {
      return jsonError(c, 400, 'window_start and window_end must be ISO-8601 instants', 'invalid');
    }
    const project = c.get('project');
    return c.json(repo.listTransitionsInWindow(project.id, startParsed.data, endParsed.data), 200);
  });

  return app;
}
