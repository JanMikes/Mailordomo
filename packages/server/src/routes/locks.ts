/**
 * Locks — the Jan/Simona double-handling guard (PROJECT.md §6).
 *
 *  - POST /locks/acquire : 200 `{acquired:true, lock}` when taken (incl. heartbeat re-acquire by the
 *    holder and takeover of an EXPIRED lock); 409 `{acquired:false, lock}` when a different actor
 *    still holds it (the body carries the current holder for presence); 404 if the thread is unknown.
 *  - POST /locks/refresh : 200 `lock` (extends expiry for the holder); 409 if held by another;
 *    404 if no lock / unknown thread.
 *  - POST /locks/release : 200 `{released}` — true when freed (or already free), false when a
 *    different active holder owns it.
 *  - GET  /locks         : active (unexpired) locks for the project.
 */
import { Hono } from 'hono';
import type { AcquireLockResponse } from '@mailordomo/shared';
import {
  AcquireLockRequestSchema,
  RefreshLockRequestSchema,
  ReleaseLockRequestSchema,
} from '@mailordomo/shared';
import type { AppEnv } from '../http';
import { jsonError, parseBody } from '../http';
import { nowIso } from '../time';
import type { Repository } from '../repo/repository';

export function lockRoutes(repo: Repository): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/acquire', async (c) => {
    const parsed = await parseBody(c, AcquireLockRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const result = repo.acquireLock(project.id, parsed.data, nowIso());
    if (result.outcome === 'not-found' || result.lock === undefined) {
      return jsonError(c, 404, 'thread not found', 'not_found');
    }
    const body: AcquireLockResponse = {
      acquired: result.outcome === 'acquired',
      lock: result.lock,
    };
    return c.json(body, result.outcome === 'acquired' ? 200 : 409);
  });

  app.post('/refresh', async (c) => {
    const parsed = await parseBody(c, RefreshLockRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    const result = repo.refreshLock(project.id, parsed.data, nowIso());
    if (result.outcome === 'refreshed' && result.lock !== undefined) {
      return c.json(result.lock, 200);
    }
    if (result.outcome === 'contended') {
      return jsonError(c, 409, 'lock held by a different actor', 'conflict');
    }
    return jsonError(c, 404, 'no lock to refresh', 'not_found');
  });

  app.post('/release', async (c) => {
    const parsed = await parseBody(c, ReleaseLockRequestSchema);
    if (!parsed.ok) return parsed.res;
    const project = c.get('project');
    return c.json(repo.releaseLock(project.id, parsed.data, nowIso()), 200);
  });

  app.get('/', (c) => {
    const project = c.get('project');
    return c.json(repo.listLocks(project.id, nowIso()), 200);
  });

  return app;
}
