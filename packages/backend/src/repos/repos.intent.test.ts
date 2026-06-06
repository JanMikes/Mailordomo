/**
 * INTENT (separate test-author) — repo pointers, two modes (PROJECT.md §10; PLAN.md D33/D13).
 *
 * Additive to `repos.smoke.test.ts`: `resolveRepoAddDirs` (UNTESTED in smoke — it gates what reaches
 * `claude --add-dir`, so a stale/missing path must be dropped); the pure scheduler's STRICT boundary
 * (just-under-interval is NOT due; a future `lastPulledAt` from clock skew is NOT due; empty input);
 * and that the mirror argv passes a freeform scp-style git URL VERBATIM and only ever fetches (never
 * pushes). No real `git`, no clock — the runner is the fake seam and `now` is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalRepoConfig } from '@mailordomo/shared';
import {
  createFakeGitRunner,
  mirrorClone,
  mirrorFetch,
  reposDueForPull,
  resolveRepoAddDirs,
  resolveRepoMirrorDir,
  validateLocalRepoPath,
} from './index';

/* --------------------------- resolveRepoAddDirs ------------------------------ */

describe('resolveRepoAddDirs — only EXISTING local clones reach `claude --add-dir`', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailordomo-adddir-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function repo(local_path: string): LocalRepoConfig {
    return { repo_pointer_id: `id-${local_path}`, local_path, active_pull: false };
  }

  it('keeps real directories, drops missing paths and files (real fs)', () => {
    const liveA = join(dir, 'repoA');
    const liveB = join(dir, 'repoB');
    mkdirSync(liveA);
    mkdirSync(liveB);
    const missing = join(dir, 'gone');
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');

    const dirs = resolveRepoAddDirs([repo(liveA), repo(missing), repo(file), repo(liveB)]);
    expect(dirs).toEqual([liveA, liveB]); // order preserved; missing + file dropped
  });

  it('drops EVERY repo when none exist (a wholly stale config passes no bad dir to claude)', () => {
    const dirs = resolveRepoAddDirs([repo('/no/such/a'), repo('/no/such/b')]);
    expect(dirs).toEqual([]);
  });

  it('is pure given an injected stat (no real fs touched)', () => {
    const present = new Set(['/live']);
    const stat = (p: string) => {
      if (!present.has(p)) throw new Error('ENOENT');
      return { isDirectory: () => true };
    };
    expect(resolveRepoAddDirs([repo('/live'), repo('/dead')], stat)).toEqual(['/live']);
  });
});

/* ---------------------------- pull scheduler --------------------------------- */

describe('reposDueForPull — strict interval boundary + clock-skew safety', () => {
  const now = Date.parse('2026-06-06T12:00:00.000Z');
  const intervalMs = 15 * 60 * 1000;

  function dueIds(lastPulledAt: string | null): string[] {
    return reposDueForPull({
      now,
      intervalMs,
      repos: [{ repoPointerId: 'r', activePull: true, lastPulledAt }],
    }).map((r) => r.repoPointerId);
  }

  it('exactly AT the interval is due; one millisecond UNDER is NOT', () => {
    expect(dueIds(new Date(now - intervalMs).toISOString())).toEqual(['r']); // ==15m → due
    expect(dueIds(new Date(now - intervalMs + 1).toISOString())).toEqual([]); // 14m59.999s → not
    expect(dueIds(new Date(now - intervalMs - 1).toISOString())).toEqual(['r']); // 15m00.001s → due
  });

  it('a future lastPulledAt (clock skew) is NOT due — negative elapsed never trips the >= check', () => {
    expect(dueIds(new Date(now + 60_000).toISOString())).toEqual([]);
  });

  it('empty input yields an empty due set', () => {
    expect(reposDueForPull({ now, intervalMs, repos: [] })).toEqual([]);
  });

  it('returns the exact subset (mixed) — active+due only, preserving identity', () => {
    const due = reposDueForPull({
      now,
      intervalMs,
      repos: [
        { repoPointerId: 'never', activePull: true, lastPulledAt: null },
        { repoPointerId: 'due', activePull: true, lastPulledAt: '2026-06-06T11:30:00.000Z' },
        { repoPointerId: 'fresh-off', activePull: false, lastPulledAt: null },
        { repoPointerId: 'fresh-on', activePull: true, lastPulledAt: '2026-06-06T11:59:00.000Z' },
      ],
    });
    expect(due.map((r) => r.repoPointerId)).toEqual(['never', 'due']);
  });
});

/* ------------------------------ mirror argv ---------------------------------- */

describe('mirror operations — read-only, freeform URL passed verbatim', () => {
  it('clone --mirror passes an scp-style git URL UNCHANGED (not URL-mangled)', async () => {
    const git = createFakeGitRunner();
    const url = 'git@github.com:org/repo.git'; // not a parseable URL — must survive verbatim
    const mirrorDir = resolveRepoMirrorDir('r1', { MAILORDOMO_CONFIG_DIR: '/cfg' });
    await mirrorClone(git, url, mirrorDir);
    expect(git.calls[0]?.args).toEqual(['clone', '--mirror', url, '/cfg/repo-mirrors/r1']);
    expect(git.calls[0]?.args).not.toContain('push');
  });

  it('fetch is scoped to the mirror dir with --prune, and nothing pushes', async () => {
    const git = createFakeGitRunner();
    await mirrorFetch(git, '/cfg/repo-mirrors/r1');
    expect(git.calls[0]?.args).toEqual(['-C', '/cfg/repo-mirrors/r1', 'fetch', '--prune']);
    expect(git.calls.flatMap((c) => c.args)).not.toContain('push');
  });

  it('a non-zero git exit is surfaced (not thrown) so auth-required is reportable', async () => {
    const git = createFakeGitRunner(() => ({ code: 128, stdout: '', stderr: 'fatal: auth' }));
    const res = await mirrorClone(git, 'https://x/p.git', '/cfg/repo-mirrors/r1');
    expect(res.code).toBe(128);
    expect(res.stderr).toContain('auth');
  });
});

/* --------------------------- local-path validator ---------------------------- */

describe('validateLocalRepoPath — accepts a dir, rejects a missing path or a file', () => {
  it('distinguishes dir vs file vs missing with reasons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-lp-'));
    try {
      expect(validateLocalRepoPath(dir)).toEqual({ ok: true, reason: 'ok' });
      const file = join(dir, 'f');
      writeFileSync(file, 'x');
      expect(validateLocalRepoPath(file).ok).toBe(false);
      expect(validateLocalRepoPath(join(dir, 'nope')).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
