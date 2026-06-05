/**
 * Locks — the Jan/Simona double-handling guard (PROJECT.md §6 "timeout release"; PLAN.md §7 Phase 2
 * "lock acquire/contend/timeout/release"; open Q #24 → 30-min TTL).
 *
 * Three layers, all deterministic (NO sleeping — the clock is injected everywhere it matters):
 *   1. the pure `locks.ts` TTL helpers (injected `Date`);
 *   2. the repo's acquire decision with an injected `now` string — contend / expire-takeover /
 *      heartbeat (this is where the timeout arithmetic actually gates behavior);
 *   3. the HTTP endpoints — acquire → contend → release → re-acquire, refresh extends for the
 *      holder, refresh/release by a non-holder are rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { AcquireLockResponse, Lock, ReleaseLockResponse } from '@mailordomo/shared';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { computeExpiry, DEFAULT_LOCK_TTL_SECONDS, isExpired, resolveTtlSeconds } from './locks';
import { createSqliteRepository, IN_MEMORY_DB } from './repo/sqlite';
import {
  assertDefined,
  authHeaders,
  PROJECT_A,
  PROJECT_B,
  makeApp,
  readJson,
  seedProject,
  seedThread,
} from './test-helpers';

describe('locks.ts pure TTL helpers (injected clock)', () => {
  const now = new Date('2026-06-05T12:00:00.000Z');

  it('isExpired is false before, true at and after expiry', () => {
    expect(isExpired('2026-06-05T12:30:00.000Z', now)).toBe(false);
    expect(isExpired('2026-06-05T11:30:00.000Z', now)).toBe(true);
    // boundary: now === expires_at counts as expired (so the slot is immediately reclaimable)
    expect(isExpired('2026-06-05T12:00:00.000Z', now)).toBe(true);
  });

  it('computeExpiry returns now + ttlSeconds as ISO UTC', () => {
    expect(computeExpiry(now, DEFAULT_LOCK_TTL_SECONDS)).toBe('2026-06-05T12:30:00.000Z');
    expect(computeExpiry(now, 60)).toBe('2026-06-05T12:01:00.000Z');
  });

  it('resolveTtlSeconds passes a value through and defaults to 30 minutes', () => {
    expect(resolveTtlSeconds(120)).toBe(120);
    expect(resolveTtlSeconds(undefined)).toBe(DEFAULT_LOCK_TTL_SECONDS);
    expect(DEFAULT_LOCK_TTL_SECONDS).toBe(1800);
  });
});

describe('lock acquire decision (repo, injected now) — contend / expire / heartbeat', () => {
  let repo: Repository;
  let threadId: string;
  const t0 = '2026-06-05T12:00:00.000Z';

  beforeEach(() => {
    repo = createSqliteRepository(IN_MEMORY_DB);
    seedProject(repo, PROJECT_A);
    threadId = seedThread(repo, PROJECT_A.id).id;
  });

  afterEach(() => {
    repo.close();
  });

  it('an UNEXPIRED lock held by someone else is contended (returns the current holder)', () => {
    const first = repo.acquireLock(
      PROJECT_A.id,
      { thread_id: threadId, locked_by: 'jan', ttl_seconds: 1800 },
      t0,
    );
    expect(first.outcome).toBe('acquired');

    // 10 minutes later — still inside the 30-minute TTL
    const second = repo.acquireLock(
      PROJECT_A.id,
      { thread_id: threadId, locked_by: 'simona', ttl_seconds: 1800 },
      '2026-06-05T12:10:00.000Z',
    );
    expect(second.outcome).toBe('contended');
    expect(second.lock?.locked_by).toBe('jan');
  });

  it('an EXPIRED lock is acquirable by a different actor (timeout release)', () => {
    repo.acquireLock(PROJECT_A.id, { thread_id: threadId, locked_by: 'jan', ttl_seconds: 600 }, t0);

    // 20 minutes later — the 10-minute TTL has lapsed
    const takeover = repo.acquireLock(
      PROJECT_A.id,
      { thread_id: threadId, locked_by: 'simona', ttl_seconds: 600 },
      '2026-06-05T12:20:00.000Z',
    );
    expect(takeover.outcome).toBe('acquired');
    expect(takeover.lock?.locked_by).toBe('simona');
  });

  it('the same holder re-acquiring is a heartbeat: locked_at kept, expiry extended', () => {
    const first = repo.acquireLock(
      PROJECT_A.id,
      { thread_id: threadId, locked_by: 'jan', ttl_seconds: 1800 },
      t0,
    );
    const beat = repo.acquireLock(
      PROJECT_A.id,
      { thread_id: threadId, locked_by: 'jan', ttl_seconds: 1800 },
      '2026-06-05T12:05:00.000Z',
    );
    expect(beat.outcome).toBe('acquired');
    assertDefined(first.lock, 'first.lock');
    assertDefined(beat.lock, 'beat.lock');
    expect(beat.lock.locked_at).toBe(first.lock.locked_at);
    expect(Date.parse(beat.lock.expires_at)).toBeGreaterThan(Date.parse(first.lock.expires_at));
  });

  it('acquiring a lock on a thread outside the project is not-found', () => {
    const res = repo.acquireLock(PROJECT_A.id, { thread_id: 'ghost-thread', locked_by: 'jan' }, t0);
    expect(res.outcome).toBe('not-found');
  });
});

describe('lock endpoints: acquire → contend → release → re-acquire; refresh; non-holder', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;
  let threadId: string;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
    threadId = seedThread(repo, PROJECT_A.id).id;
  });

  afterEach(() => {
    repo.close();
  });

  const lockReq = async (path: string, payload: unknown): Promise<Response> =>
    app.request(`/locks${path}`, {
      method: 'POST',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify(payload),
    });

  it('full lifecycle: jan acquires, simona is contended, jan releases, simona acquires', async () => {
    const acquired = await lockReq('/acquire', { thread_id: threadId, locked_by: 'jan' });
    expect(acquired.status).toBe(200);
    expect((await readJson<AcquireLockResponse>(acquired)).acquired).toBe(true);

    // a different actor contends an active lock → 409, body carries the current holder for presence
    const contended = await lockReq('/acquire', { thread_id: threadId, locked_by: 'simona' });
    expect(contended.status).toBe(409);
    const contendedBody = await readJson<AcquireLockResponse>(contended);
    expect(contendedBody.acquired).toBe(false);
    expect(contendedBody.lock.locked_by).toBe('jan');

    // the holder releases
    const released = await lockReq('/release', { thread_id: threadId, locked_by: 'jan' });
    expect(released.status).toBe(200);
    expect((await readJson<ReleaseLockResponse>(released)).released).toBe(true);

    // now simona can take it
    const reacquired = await lockReq('/acquire', { thread_id: threadId, locked_by: 'simona' });
    expect(reacquired.status).toBe(200);
    expect((await readJson<AcquireLockResponse>(reacquired)).lock.locked_by).toBe('simona');
  });

  it("refresh extends the holder's expiry and returns 200", async () => {
    const acquired = await readJson<AcquireLockResponse>(
      await lockReq('/acquire', { thread_id: threadId, locked_by: 'jan', ttl_seconds: 60 }),
    );
    // a longer TTL guarantees a strictly later expiry regardless of wall-clock granularity
    const refreshed = await lockReq('/refresh', {
      thread_id: threadId,
      locked_by: 'jan',
      ttl_seconds: 3600,
    });
    expect(refreshed.status).toBe(200);
    const lock = await readJson<Lock>(refreshed);
    expect(lock.locked_by).toBe('jan');
    expect(Date.parse(lock.expires_at)).toBeGreaterThan(Date.parse(acquired.lock.expires_at));
  });

  it('refresh by a non-holder is rejected with 409', async () => {
    await lockReq('/acquire', { thread_id: threadId, locked_by: 'jan' });
    const res = await lockReq('/refresh', { thread_id: threadId, locked_by: 'simona' });
    expect(res.status).toBe(409);
  });

  it('release by a non-holder does not free an actively-held lock', async () => {
    await lockReq('/acquire', { thread_id: threadId, locked_by: 'jan' });
    const res = await lockReq('/release', { thread_id: threadId, locked_by: 'simona' });
    expect(res.status).toBe(200);
    expect((await readJson<ReleaseLockResponse>(res)).released).toBe(false);

    // jan still holds it: simona acquiring is still contended
    const contended = await lockReq('/acquire', { thread_id: threadId, locked_by: 'simona' });
    expect(contended.status).toBe(409);
  });

  it('GET /locks lists the active lock for the project', async () => {
    await lockReq('/acquire', { thread_id: threadId, locked_by: 'jan' });
    const list = await readJson<Lock[]>(
      await app.request('/locks', { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toHaveLength(1);
    expect(list).toContainEqual(expect.objectContaining({ thread_id: threadId, locked_by: 'jan' }));
  });
});

describe('lock scoping — a foreign project cannot free your lock (Golden rule #2)', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;
  let threadId: string;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
    seedProject(repo, PROJECT_B);
    threadId = seedThread(repo, PROJECT_A.id).id;
  });

  afterEach(() => {
    repo.close();
  });

  it("a release authenticated as project B does not free project A's lock", async () => {
    await app.request('/locks/acquire', {
      method: 'POST',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify({ thread_id: threadId, locked_by: 'jan' }),
    });

    // project B tries to release A's thread lock — A's thread is invisible to B, so nothing happens
    await app.request('/locks/release', {
      method: 'POST',
      headers: authHeaders(PROJECT_B),
      body: JSON.stringify({ thread_id: threadId, locked_by: 'mallory' }),
    });

    const list = await readJson<Lock[]>(
      await app.request('/locks', { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toHaveLength(1);
    expect(list).toContainEqual(expect.objectContaining({ thread_id: threadId, locked_by: 'jan' }));
  });
});
