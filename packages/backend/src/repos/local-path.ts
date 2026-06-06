/**
 * Local-path repo mode (PLAN.md §7 Phase 8, D33; PROJECT.md §10 preferred mode). The maintainer's
 * LIVE clone is read directly by Claude via `--add-dir` — no mirror. This module validates that a
 * `local_path` exists and is a directory, and collects the dirs to pass as `--add-dir`.
 *
 * PRIVACY (D13): a `local_path` is MACHINE-LOCAL and must never reach the metadata server — it lives
 * only in `LocalRepoConfig`, consumed here locally to scope a `claude` job. The `claude/build-args.ts`
 * argv builder already supports `spec.addDirs` (→ `--add-dir <dir>`), so the repo paths returned here
 * slot straight in when a repo-aware job is dispatched.
 */
import { statSync } from 'node:fs';
import type { LocalRepoConfig } from '@mailordomo/shared';

/** The result of validating one local path. */
export interface LocalPathCheck {
  readonly ok: boolean;
  readonly reason: string;
}

/** A `stat`-like seam so tests can validate without touching the real filesystem. */
export type StatLike = (path: string) => { isDirectory(): boolean };

const realStat: StatLike = (path) => statSync(path);

/** Validate a local repo path: it must exist AND be a directory. Never throws. */
export function validateLocalRepoPath(path: string, stat: StatLike = realStat): LocalPathCheck {
  try {
    return stat(path).isDirectory()
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'path is not a directory' };
  } catch {
    return { ok: false, reason: 'path does not exist or is not readable' };
  }
}

/**
 * Collect the EXISTING local-clone directories from a set of repos, for `claude --add-dir`. Skips
 * mirror-mode/missing/invalid paths so a stale config can't pass a bad dir to a `claude` job. Pure
 * given the injected `stat`.
 */
export function resolveRepoAddDirs(
  repos: readonly LocalRepoConfig[],
  stat: StatLike = realStat,
): string[] {
  return repos.map((r) => r.local_path).filter((p) => validateLocalRepoPath(p, stat).ok);
}
