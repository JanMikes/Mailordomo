/**
 * @mailordomo/server — runnable entry for the shared metadata service (Hono + better-sqlite3, WAL).
 *
 * Source of truth for task state & transitions (with actor attribution), deadlines/follow-ups,
 * 3-way promises, notes, repo pointers, draft *metadata*, locks, tone-file sync, the learning
 * changelog, and the subject/snippet/sender shared-digest surface. It NEVER stores raw email or
 * draft bodies (Golden rule #3) — enforced by the strict shared DTOs.
 *
 * Listens on `METADATA_PORT` (default 8787), host `0.0.0.0`. The application itself is built in
 * `app.ts`; tests import `createApp` directly so importing this module is the only thing that
 * starts a listening server.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { readEnv } from './env';
import { createSqliteRepository } from './repo/sqlite';
import { seedProjectFromEnv } from './seed';

function main(): void {
  const env = readEnv();
  const repo = createSqliteRepository(env.dbPath);
  seedProjectFromEnv(repo, env);
  const app = createApp({ repo });
  serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(`mailordomo-metadata-service listening on http://${env.host}:${info.port}`);
  });
}

main();
