/**
 * SMOKE — repo pointers (PLAN.md §7 Phase 8, D33): the PURE pull scheduler, the local-path validator,
 * and the mirror operations' `git` argv through the FAKE {@link GitRunner} (no real `git` in CI).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeGitRunner,
  mirrorClone,
  mirrorFetch,
  reposDueForPull,
  resolveRepoMirrorDir,
  validateLocalRepoPath,
} from './index';

describe('reposDueForPull (pure scheduler, injected now)', () => {
  const now = Date.parse('2026-06-06T12:00:00.000Z');
  const interval = 15 * 60 * 1000;

  it('returns active repos that are never-pulled or past the interval; never pulls inactive ones', () => {
    const due = reposDueForPull({
      now,
      intervalMs: interval,
      repos: [
        { repoPointerId: 'never', activePull: true, lastPulledAt: null },
        { repoPointerId: 'stale', activePull: true, lastPulledAt: '2026-06-06T11:40:00.000Z' }, // 20m ago
        { repoPointerId: 'fresh', activePull: true, lastPulledAt: '2026-06-06T11:55:00.000Z' }, // 5m ago
        { repoPointerId: 'off', activePull: false, lastPulledAt: null }, // auto-pull off → never
        { repoPointerId: 'bad', activePull: true, lastPulledAt: 'not-a-date' }, // unparseable → due
      ],
    });
    expect(due.map((r) => r.repoPointerId)).toEqual(['never', 'stale', 'bad']);
  });

  it('exactly-at-interval is due (>=)', () => {
    const due = reposDueForPull({
      now,
      intervalMs: interval,
      repos: [
        { repoPointerId: 'edge', activePull: true, lastPulledAt: '2026-06-06T11:45:00.000Z' },
      ],
    });
    expect(due).toHaveLength(1);
  });
});

describe('validateLocalRepoPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailordomo-repo-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ok for a real directory; not-ok for a missing path or a file', () => {
    expect(validateLocalRepoPath(dir).ok).toBe(true);
    expect(validateLocalRepoPath(join(dir, 'nope')).ok).toBe(false);
    // Injected stat seam: a path that exists but is not a directory.
    expect(validateLocalRepoPath('/whatever', () => ({ isDirectory: () => false })).ok).toBe(false);
  });
});

describe('mirror operations build read-only `git` argv via the seam', () => {
  it('clone --mirror then fetch --prune, no push', async () => {
    const git = createFakeGitRunner();
    const mirrorDir = resolveRepoMirrorDir('r1', { MAILORDOMO_CONFIG_DIR: '/tmp/cfg' });
    expect(mirrorDir).toBe('/tmp/cfg/repo-mirrors/r1');

    await mirrorClone(git, 'https://example.com/app.git', mirrorDir);
    await mirrorFetch(git, mirrorDir);

    expect(git.calls[0]?.args).toEqual([
      'clone',
      '--mirror',
      'https://example.com/app.git',
      mirrorDir,
    ]);
    expect(git.calls[1]?.args).toEqual(['-C', mirrorDir, 'fetch', '--prune']);
    // Nothing here pushes (read-only mirror).
    expect(git.calls.some((call) => call.args.includes('push'))).toBe(false);
  });

  it('surfaces a non-zero git exit without throwing', async () => {
    const git = createFakeGitRunner(() => ({ code: 128, stdout: '', stderr: 'auth failed' }));
    const result = await mirrorFetch(git, '/tmp/cfg/repo-mirrors/r1');
    expect(result.code).toBe(128);
    expect(result.stderr).toBe('auth failed');
  });
});
