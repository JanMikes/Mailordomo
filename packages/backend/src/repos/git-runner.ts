/**
 * The `GitRunner` injection seam (PLAN.md §7 Phase 8, D33). Repo-mirror operations spawn `git`
 * through THIS interface, never `child_process` directly, so tests inject a FAKE — CI runs no real
 * `git`. The real impl spawns `git` with an args ARRAY (no shell). Repo URLs/paths are NOT secrets
 * (the repo PAT/SSH path is documented + deferred), so argv here is safe to surface in diagnostics.
 */
import { spawn } from 'node:child_process';

/** The result of one `git` invocation. `code` is the process exit code (-1 if git couldn't spawn). */
export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `git <args>` (optionally in `cwd`). Resolves with the result; never rejects on a non-zero exit. */
export interface GitRunner {
  run(args: readonly string[], options?: { cwd?: string }): Promise<GitRunResult>;
}

/**
 * The real {@link GitRunner} — spawns the `git` binary. A spawn failure (e.g. git not installed)
 * resolves with `code: -1` + the message on `stderr` rather than throwing, so callers can report
 * "git unavailable" cleanly.
 */
export function createGitRunner(): GitRunner {
  return {
    run(args, options) {
      return new Promise<GitRunResult>((resolve) => {
        const child = spawn('git', args as string[], {
          cwd: options?.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
        child.on('error', (cause) => {
          resolve({ code: -1, stdout, stderr: stderr || cause.message });
        });
        child.on('close', (code) => {
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

/** A fake {@link GitRunner} that records calls and returns a canned result. For tests only. */
export interface FakeGitRunner extends GitRunner {
  /** Every `run` call's args + cwd, in order. */
  readonly calls: Array<{ args: string[]; cwd?: string }>;
}

/**
 * Build a {@link FakeGitRunner}. `handler` maps a call to its {@link GitRunResult}; it defaults to a
 * success (`code: 0`). Recorded `calls` let a test assert the exact `git` argv WITHOUT spawning.
 */
export function createFakeGitRunner(
  handler: (args: readonly string[], cwd?: string) => GitRunResult = () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }),
): FakeGitRunner {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  return {
    calls,
    run(args, options) {
      calls.push({ args: [...args], ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
      return Promise.resolve(handler(args, options?.cwd));
    },
  };
}
