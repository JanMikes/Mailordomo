/**
 * Minimal smoke test (per the Phase 2 role split): the app boots against an in-memory, fully
 * migrated DB and `GET /health` returns 200. The comprehensive metadata-API suite (auth, CRUD,
 * lock semantics, tone LWW, privacy rejection) is written by a SEPARATE test author.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createSqliteRepository, IN_MEMORY_DB } from './repo/sqlite';

describe('server smoke', () => {
  it('boots and serves GET /health', async () => {
    const repo = createSqliteRepository(IN_MEMORY_DB);
    const app = createApp({ repo });

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    repo.close();
  });
});
