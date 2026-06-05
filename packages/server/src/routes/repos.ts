/**
 * Repo pointers — SHARED repo identity only (name + git_url). The machine-local clone path never
 * crosses to the server (decision D13); the strict DTO has no field for it.
 */
import { Hono } from 'hono';
import { CreateRepoPointerRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import type { Repository } from '../repo/repository';

export function repoRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreateRepoPointerRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    if (parsed.data.project_id !== project.id) {
      return jsonError(c, 403, 'project_id does not match the authenticated project', 'forbidden');
    }
    return c.json(repo.createRepoPointer(project.id, parsed.data), 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listRepoPointers(project.id), 200);
  });

  return app;
}
