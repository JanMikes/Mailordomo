/**
 * Learning changelog — silent, revertable (PROJECT.md §6). Create an entry, list the changelog, or
 * revert an entry by id (sets `reverted_at`; idempotent). The revert body is an empty strict object,
 * so even here a smuggled key is rejected.
 */
import { Hono } from 'hono';
import {
  CreateLearningEntryRequestSchema,
  RevertLearningEntryRequestSchema,
} from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function learningRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreateLearningEntryRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    if (parsed.data.project_id !== project.id) {
      return jsonError(c, 403, 'project_id does not match the authenticated project', 'forbidden');
    }
    return c.json(repo.createLearningEntry(project.id, parsed.data, nowIso()), 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listLearningEntries(project.id), 200);
  });

  app.post('/:id/revert', async (c) => {
    const parsed = await parseBody(c, RevertLearningEntryRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const entry = repo.revertLearningEntry(project.id, c.req.param('id'), nowIso());
    if (entry === undefined) return jsonError(c, 404, 'learning entry not found', 'not_found');
    return c.json(entry, 200);
  });

  return app;
}
