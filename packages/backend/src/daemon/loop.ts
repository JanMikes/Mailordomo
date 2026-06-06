/**
 * The continuous daemon loop (PROJECT.md §4/§6; PLAN.md D34) — runs {@link runDaemonCycle} on a
 * cadence. Per §4 the live wiring is IDLE-hot + poll-cold: an injected {@link DaemonConnection}
 * (a `ResilientImapConnection`, reused from Phase 3) keeps the watched mailbox connected and triggers
 * a cycle on new-mail activity (HOT), while a fixed interval sweeps the rest (COLD). The connection's
 * own `onReady`/exists wiring (set up in the composition root) calls back into `runCycleNow`.
 *
 * NOT AUTO-STARTED IN TESTS: this is invoked only by the runnable composition root (`api/server.ts`),
 * guarded by config/env, and `launchd` runs it in production. Constructing the API for tests never
 * spins a live loop. Timers + the connection are injected so the loop is itself testable without
 * real waiting (PLAN.md §5).
 *
 * GOLDEN RULE #1: like the rest of `daemon/**`, this imports no `smtp/**`/`api/**`/root barrel — it
 * only schedules the send-proof cycle.
 */
import { runDaemonCycle } from './cycle';
import type { DaemonCycleDeps, DaemonCycleResult } from './types';

/** Minimal interval-timer surface (injected so tests drive cadence without the wall clock). */
export interface IntervalTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realIntervalTimers: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** The connection the loop drives for the IDLE-hot path. `ResilientImapConnection` satisfies this. */
export interface DaemonConnection {
  start(): Promise<void> | void;
  stop(): void;
}

export interface StartDaemonOptions {
  /** Cold-poll interval in ms (e.g. 5 min per §4 / open Q #25). */
  readonly intervalMs: number;
  /** Run a cycle immediately on start (default true). */
  readonly immediate?: boolean;
  /** Injected timers (default real `setInterval`). */
  readonly timers?: IntervalTimers;
  /** Optional IMAP connection for the IDLE-hot path (reused `ResilientImapConnection`). */
  readonly connection?: DaemonConnection;
  /** Observe each completed cycle (logs/metrics/tests). */
  readonly onCycle?: (result: DaemonCycleResult) => void;
  /** Observe a cycle that threw (the loop itself never crashes). */
  readonly onError?: (error: unknown) => void;
}

/** Handle to stop the running loop (and tear down the connection). Idempotent. */
export interface DaemonHandle {
  /** Trigger a cycle now (the IDLE-hot path / a manual kick). Never throws; never overlaps. */
  runCycleNow(): void;
  stop(): void;
}

/**
 * Start the continuous loop. Returns a {@link DaemonHandle}; cycles never overlap (a tick while one
 * is in flight is skipped). The injected connection (if any) is started for the IDLE-hot path; its
 * activity handler should call `handle.runCycleNow()`.
 */
export function startDaemon(deps: DaemonCycleDeps, options: StartDaemonOptions): DaemonHandle {
  const timers = options.timers ?? realIntervalTimers;
  let running = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    void runDaemonCycle(deps)
      .then((result) => options.onCycle?.(result))
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  };

  if (options.connection) {
    void Promise.resolve(options.connection.start()).catch((error: unknown) =>
      options.onError?.(error),
    );
  }
  if (options.immediate !== false) tick();
  const handle = timers.setInterval(tick, options.intervalMs);

  return {
    runCycleNow: tick,
    stop: () => {
      stopped = true;
      timers.clearInterval(handle);
      options.connection?.stop();
    },
  };
}
