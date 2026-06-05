/**
 * Tone-file last-write-wins (PROJECT.md §3 / Golden rule #2: "Tone-memory markdown syncs via the
 * server as arbiter, last-write-wins per file" — NO two-way merge; PLAN.md §7 Phase 2 "tone-file
 * LWW conflict resolution").
 *
 * Intent: the server is the sole arbiter. For a given file key (project_id, scope, path):
 *   - the newer `updated_at` wins;
 *   - a tie on `updated_at` is broken deterministically by `version_hash`;
 *   - a STALE write is a no-op and the response returns the CURRENT winner as `file` (so the loser
 *     adopts it — that is the whole point of LWW with the server as arbiter);
 *   - read-back always reflects the winner; LWW is per-file (independent keys don't interfere).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { PutToneFileResponse, ToneFile } from '@mailordomo/shared';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { authHeaders, PROJECT_A, makeApp, readJson, seedProject } from './test-helpers';

describe('tone-file last-write-wins', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;

  const base = { project_id: PROJECT_A.id, scope: 'project' as const, path: 'project/acme.md' };

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
  });

  afterEach(() => {
    repo.close();
  });

  const put = async (payload: unknown): Promise<Response> =>
    app.request('/tone', {
      method: 'PUT',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify(payload),
    });

  const listOne = async (): Promise<ToneFile> => {
    const files = await readJson<ToneFile[]>(
      await app.request('/tone', { headers: authHeaders(PROJECT_A) }),
    );
    expect(files).toHaveLength(1);
    const file = files[0];
    if (file === undefined) throw new Error('expected one tone file');
    return file;
  };

  // Seed the baseline winner: content "v1", at 12:00, hash "h-b".
  const seedV1 = (): Promise<Response> =>
    put({
      ...base,
      content: 'v1',
      version_hash: 'h-b',
      updated_by: 'jan',
      updated_at: '2026-06-05T12:00:00Z',
    });

  it('accepts the first write and makes it the winner', async () => {
    const res = await seedV1();
    expect(res.status).toBe(200);
    const body = await readJson<PutToneFileResponse>(res);
    expect(body.accepted).toBe(true);
    expect(body.file.content).toBe('v1');
    expect((await listOne()).content).toBe('v1');
  });

  it('a STALE write (older updated_at) is a no-op and returns the current winner', async () => {
    await seedV1();
    // older timestamp, even with a "higher" hash, must lose to the newer-instant winner
    const stale = await put({
      ...base,
      content: 'OLD',
      version_hash: 'h-z',
      updated_by: 'simona',
      updated_at: '2026-06-05T11:00:00Z',
    });
    const body = await readJson<PutToneFileResponse>(stale);
    expect(body.accepted).toBe(false);
    expect(body.file.content).toBe('v1');
    expect(body.file.version_hash).toBe('h-b');
    expect((await listOne()).content).toBe('v1');
  });

  it('a NEWER write (later updated_at) wins even with a lower version_hash', async () => {
    await seedV1();
    const newer = await put({
      ...base,
      content: 'v2',
      version_hash: 'h-a', // lexically lower than the current "h-b"
      updated_by: 'simona',
      updated_at: '2026-06-05T13:00:00Z',
    });
    const body = await readJson<PutToneFileResponse>(newer);
    expect(body.accepted).toBe(true);
    expect(body.file.content).toBe('v2');
    expect((await listOne()).content).toBe('v2');
  });

  it('a TIE on updated_at is broken by version_hash (higher hash wins; lower no-ops)', async () => {
    const at = '2026-06-05T12:00:00Z';
    await put({ ...base, content: 'mid', version_hash: 'h-m', updated_by: 'jan', updated_at: at });

    // same instant, lower hash → loses, winner unchanged
    const lower = await put({
      ...base,
      content: 'lower',
      version_hash: 'h-a',
      updated_by: 'simona',
      updated_at: at,
    });
    expect((await readJson<PutToneFileResponse>(lower)).accepted).toBe(false);
    expect((await listOne()).content).toBe('mid');

    // same instant, higher hash → wins
    const higher = await put({
      ...base,
      content: 'higher',
      version_hash: 'h-z',
      updated_by: 'simona',
      updated_at: at,
    });
    const body = await readJson<PutToneFileResponse>(higher);
    expect(body.accepted).toBe(true);
    expect(body.file.content).toBe('higher');
    expect((await listOne()).content).toBe('higher');
  });

  it('LWW is per-file: an older write to a DIFFERENT path is independent', async () => {
    await seedV1();
    const other = await put({
      project_id: PROJECT_A.id,
      scope: 'contact',
      path: 'contact/petr.md',
      content: 'contact tone',
      version_hash: 'h-1',
      updated_by: 'jan',
      updated_at: '2026-06-05T10:00:00Z', // older than v1, but a different key
    });
    expect((await readJson<PutToneFileResponse>(other)).accepted).toBe(true);

    const files = await readJson<ToneFile[]>(
      await app.request('/tone', { headers: authHeaders(PROJECT_A) }),
    );
    expect(files).toHaveLength(2);
  });
});
