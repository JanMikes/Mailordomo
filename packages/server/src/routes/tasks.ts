/**
 * Tasks & transitions. State changes go through `POST /tasks/:id/transitions`, which records the
 * actor (powering the digest's "what Simona handled") and supports `expected_from` for optimistic
 * concurrency (409 on a stale transition). Transition LEGALITY is the Phase 3 state machine's job.
 */
import { Hono } from 'hono';
import {
  CreateTaskRequestSchema,
  CreateTaskTransitionRequestSchema,
  UpdateTaskRequestSchema,
} from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function taskRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreateTaskRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const task = repo.createTask(project.id, parsed.data, nowIso());
    if (task === undefined) return jsonError(c, 404, 'thread not found', 'not_found');
    return c.json(task, 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    const threadId = c.req.query('thread_id');
    return c.json(repo.listTasks(project.id, threadId), 200);
  });

  app.get('/:id', (c) => {
    const project = c.get('project');
    const task = repo.getTask(project.id, c.req.param('id'));
    if (task === undefined) return jsonError(c, 404, 'task not found', 'not_found');
    return c.json(task, 200);
  });

  app.patch('/:id', async (c) => {
    const parsed = await parseBody(c, UpdateTaskRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const task = repo.updateTask(project.id, c.req.param('id'), parsed.data, nowIso());
    if (task === undefined) return jsonError(c, 404, 'task not found', 'not_found');
    return c.json(task, 200);
  });

  app.post('/:id/transitions', async (c) => {
    const parsed = await parseBody(c, CreateTaskTransitionRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const result = repo.createTransition(project.id, c.req.param('id'), parsed.data, nowIso());
    if (!result.ok) {
      if (result.reason === 'not-found') return jsonError(c, 404, 'task not found', 'not_found');
      return jsonError(c, 409, 'task state changed since expected_from', 'conflict');
    }
    return c.json(result.transition, 201);
  });

  app.get('/:id/transitions', (c) => {
    const project = c.get('project');
    const transitions = repo.listTransitions(project.id, c.req.param('id'));
    if (transitions === undefined) return jsonError(c, 404, 'task not found', 'not_found');
    return c.json(transitions, 200);
  });

  return app;
}
