/**
 * Notes — per-thread USER notes. `body` here is the user's own text (a sanctioned non-email field),
 * the single legitimate `body` on the server (privacy.ts).
 */
import { Hono } from 'hono';
import { CreateNoteRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function noteRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const parsed = await parseBody(c, CreateNoteRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const note = repo.createNote(project.id, parsed.data, nowIso());
    if (note === undefined) return jsonError(c, 404, 'thread not found', 'not_found');
    return c.json(note, 201);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listNotes(project.id, c.req.query('thread_id')), 200);
  });

  return app;
}
