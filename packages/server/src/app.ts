/**
 * The Hono application factory. Takes a {@link Repository} so the app is fully testable with
 * Hono's `app.request()` against an in-memory or temp DB (see `app.test.ts`); the runnable entry
 * (`index.ts`) wires a sqlite repo and serves it.
 *
 * SECURITY-CRITICAL ORDERING: public routes (`/health`, `/pair`) are registered BEFORE the
 * bearer-auth middleware; every data router is registered AFTER it. Hono runs matched
 * middleware/handlers in registration order, so the auth gate wraps the data routes and NOT the
 * public ones. Do not reorder without re-checking that every data endpoint stays authenticated.
 */
import { Hono } from 'hono';
import type { ApiError } from '@mailordomo/shared';
import type { AppEnv } from './http';
import { bearerAuth } from './auth';
import type { Repository } from './repo/repository';
import { pairingRoutes } from './routes/pairing';
import { threadRoutes } from './routes/threads';
import { taskRoutes } from './routes/tasks';
import { promiseRoutes } from './routes/promises';
import { noteRoutes } from './routes/notes';
import { repoRoutes } from './routes/repos';
import { draftRoutes } from './routes/drafts';
import { lockRoutes } from './routes/locks';
import { toneRoutes } from './routes/tone';
import { learningRoutes } from './routes/learning';
import { digestRoutes } from './routes/digest';

export interface AppDeps {
  repo: Repository;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { repo } = deps;
  const app = new Hono<AppEnv>();

  // Uniform error envelopes for unmatched routes and uncaught errors.
  app.notFound((c) => c.json({ error: 'not found', code: 'not_found' } satisfies ApiError, 404));
  app.onError((err, c) => {
    console.error('unhandled error', err);
    return c.json({ error: 'internal server error', code: 'internal' } satisfies ApiError, 500);
  });

  // Public (no auth): liveness + pairing (the credential check itself).
  app.get('/health', (c) => c.json({ status: 'ok' }, 200));
  app.route('/', pairingRoutes(repo));

  // Everything below requires a valid project bearer token, scoped to that project.
  app.use('*', bearerAuth(repo));

  app.route('/threads', threadRoutes(repo));
  app.route('/tasks', taskRoutes(repo));
  app.route('/promises', promiseRoutes(repo));
  app.route('/notes', noteRoutes(repo));
  app.route('/repos', repoRoutes(repo));
  app.route('/drafts', draftRoutes(repo));
  app.route('/locks', lockRoutes(repo));
  app.route('/tone', toneRoutes(repo));
  app.route('/learning', learningRoutes(repo));
  app.route('/digest', digestRoutes(repo));

  return app;
}
