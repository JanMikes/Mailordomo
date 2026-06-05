/**
 * Tone-file sync — LAST-WRITE-WINS per file (PROJECT.md §3, golden rule #2: the server is the sole
 * arbiter; there is no two-way merge). `PUT /tone` returns `{accepted, file}`: `accepted` is the
 * LWW verdict and `file` is always the post-resolution authoritative version the client must adopt.
 * `content` is the sanctioned derived-memory field.
 */
import { Hono } from 'hono';
import { PutToneFileRequestSchema } from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import type { Repository } from '../repo/repository';

export function toneRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/', async (c) => {
    const parsed = await parseBody(c, PutToneFileRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    if (parsed.data.project_id !== project.id) {
      return jsonError(c, 403, 'project_id does not match the authenticated project', 'forbidden');
    }
    return c.json(repo.putToneFile(project.id, parsed.data), 200);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listToneFiles(project.id), 200);
  });

  return app;
}
