/**
 * The REAL Claude runner — the thin IO glue that spawns `claude` per the ground-truthed facts and
 * reuses the two PURE seams: `buildClaudeArgs` (argv) and `parseClaudeJson` (envelope → JobResult).
 *
 * Design (PROJECT.md §4, golden rule #5):
 *  - Spawn with an ARGS ARRAY (no shell) → no shell-injection surface.
 *  - Pass the (possibly large) prompt over STDIN, not argv → dodges ARG_MAX; ~10 MB cap upstream.
 *  - Each call is STATELESS — no `--continue`/`--resume`.
 *  - HANG-GUARD IS IN NODE: macOS has no `timeout` binary, so we never shell out to it. We use an
 *    `AbortController` armed by a `setTimeout`; on timeout we SIGTERM (then SIGKILL) the child and
 *    reject. (PROJECT.md §4's "shell `timeout`" is wrong on macOS — exit 127 — corrected here.)
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { modelAliasForSpec, buildClaudeArgs } from './build-args';
import { parseClaudeJson } from './parse-json';
import { warnIfAnthropicApiKeySetOnce } from './subscription';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** How long to wait for a graceful SIGTERM before escalating to SIGKILL after a timeout. */
const SIGKILL_GRACE_MS = 2_000;

/** The default hang-guard budget when a spec doesn't set one (90s — generous for an Opus call). */
export const DEFAULT_TIMEOUT_MS = 90_000;

/** Error raised when the hang-guard fires (the child exceeded its `timeoutMs`). */
export class ClaudeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`claude job exceeded its ${timeoutMs}ms timeout and was killed`);
    this.name = 'ClaudeTimeoutError';
  }
}

/** Error raised when `claude` exits non-zero (or fails to spawn) with no parseable envelope. */
export class ClaudeSpawnError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ClaudeSpawnError';
  }
}

/** Options for the real runner — the binary path and an injectable spawn for tests if ever needed. */
export interface ClaudeRunnerOptions {
  /** Path/name of the `claude` binary. Default: `claude` (resolved on PATH). */
  readonly binPath?: string;
  /** Default hang-guard when a spec omits `timeoutMs`. */
  readonly defaultTimeoutMs?: number;
  /** Spawn function seam — defaults to `node:child_process.spawn`; overridable in tests. */
  readonly spawnFn?: typeof spawn;
}

/**
 * Spawns the headless `claude` binary. This class is intentionally tiny: all the testable logic
 * lives in the pure seams; this only wires stdin/stdout/stderr, the Node timeout, and process exit.
 */
export class RealClaudeRunner implements ClaudeRunner {
  private readonly binPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly spawnFn: typeof spawn;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.binPath = options.binPath ?? 'claude';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? spawn;
    // Subscription guard: warn (once per process) if ANTHROPIC_API_KEY is set — it would make the
    // spawned `claude` bill the paid API per token instead of consuming the user's subscription.
    warnIfAnthropicApiKeySetOnce();
  }

  run(spec: JobSpec): Promise<JobResult> {
    const args = buildClaudeArgs(spec);
    const fallbackAlias = modelAliasForSpec(spec);
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<JobResult>((resolve, reject) => {
      const controller = new AbortController();
      const child: ChildProcessWithoutNullStreams = this.spawnFn(this.binPath, args, {
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        // AbortController sends SIGTERM; escalate to SIGKILL if it lingers.
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (timedOut) {
            reject(new ClaudeTimeoutError(timeoutMs));
            return;
          }
          // A spawn-time failure (e.g. ENOENT — `claude` not on PATH) has no process exit code.
          reject(
            new ClaudeSpawnError(`failed to spawn '${this.binPath}': ${err.message}`, null, stderr),
          );
        });
      });

      child.on('close', (code: number | null) => {
        finish(() => {
          if (timedOut) {
            reject(new ClaudeTimeoutError(timeoutMs));
            return;
          }
          // Try to parse the JSON envelope regardless of exit code: `claude` may emit a structured
          // error envelope (is_error / api_error_status) AND a non-zero code. Prefer the envelope.
          try {
            resolve(parseClaudeJson(stdout, fallbackAlias));
          } catch (parseErr) {
            reject(
              new ClaudeSpawnError(
                `claude exited ${code ?? 'null'} without a parseable JSON envelope: ${
                  (parseErr as Error).message
                }`,
                code,
                stderr,
              ),
            );
          }
        });
      });

      // Feed the prompt over stdin (not argv) and close it.
      child.stdin.on('error', () => {
        // Ignore EPIPE: if the child died early, `close`/`error` handles the rejection.
      });
      child.stdin.write(spec.prompt);
      child.stdin.end();
    });
  }
}
