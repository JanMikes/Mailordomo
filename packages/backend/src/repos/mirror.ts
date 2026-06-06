/**
 * Read-only repo MIRROR operations (PLAN.md §7 Phase 8, D33; PROJECT.md §10 git-URL fallback mode).
 *
 * For a repo linked by git URL (e.g. for Simona, a non-maintainer), Mailordomo keeps a READ-ONLY
 * `git clone --mirror` under the config dir and refreshes it with a scheduled `git fetch` when the
 * "actively pull" flag is on, so even a non-maintainer's Claude has current code for `--add-dir`
 * context. These operations run `git` through the injected {@link GitRunner} seam (mockable; no real
 * `git` in CI).
 *
 * PRIVATE REPOS (documented + DEFERRED, #27): a private `git_url` needs a PAT or SSH key. v1 builds
 * the mirror + schedule for PUBLIC/credential-helper-resolved repos; the PAT path (stored in the
 * CredentialStore under `repo-pat`, injected as an `https://<pat>@host` URL or `GIT_ASKPASS`) is
 * noted here and left for a follow-up so no half-built auth lands.
 */
import { join } from 'node:path';
import { resolveConfigDir } from '../settings';
import type { GitRunner, GitRunResult } from './git-runner';

/** The directory holding all read-only mirrors. */
export function resolveRepoMirrorsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigDir(env), 'repo-mirrors');
}

/** The mirror dir for one repo: `<configDir>/repo-mirrors/<repoPointerId>`. */
export function resolveRepoMirrorDir(
  repoPointerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveRepoMirrorsDir(env), repoPointerId);
}

/**
 * Create the read-only mirror: `git clone --mirror <gitUrl> <mirrorDir>`. Read-only by construction —
 * a `--mirror` clone is a bare repo we only ever `fetch` into; nothing here pushes. Returns the raw
 * {@link GitRunResult} so the caller can branch on `code` (a non-zero exit, e.g. auth required, is
 * surfaced, not thrown).
 */
export function mirrorClone(
  git: GitRunner,
  gitUrl: string,
  mirrorDir: string,
): Promise<GitRunResult> {
  return git.run(['clone', '--mirror', gitUrl, mirrorDir]);
}

/**
 * Refresh an existing mirror: `git -C <mirrorDir> fetch --prune`. `--prune` drops deleted remote
 * refs so the mirror tracks the remote exactly. Still read-only (fetch never writes upstream).
 */
export function mirrorFetch(git: GitRunner, mirrorDir: string): Promise<GitRunResult> {
  return git.run(['-C', mirrorDir, 'fetch', '--prune']);
}
