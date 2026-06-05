/**
 * Concurrency-limited Claude job queue (PROJECT.md §4: "the local backend runs a job queue";
 * multiple `claude -p` processes run safely in parallel, each gets a unique `session_id`).
 *
 * Responsibilities:
 *  - Run at most N jobs in parallel (configurable cap, default small); excess QUEUE.
 *  - Apply the usage-THROTTLE gate BEFORE dispatch (backpressure: deferrable jobs refused once the
 *    rolling subscription window is over the throttle; essential ones proceed with a warning) and
 *    RECORD each call's notional usage after it completes.
 *  - Each job logs its notional usage via the throttle (a subscription-window-share signal, NOT money).
 *  - Warn once at startup if `ANTHROPIC_API_KEY` is set (would divert `claude` to the paid API).
 *
 * The queue holds a {@link ClaudeRunner} (real or fake) and a {@link UsageThrottle}, so it is fully
 * testable: a fake runner + a fixed clock/usage-window prove ordering, the throttle, and accounting
 * with no API and no wall clock.
 */
import { warnIfAnthropicApiKeySetOnce } from './subscription';
import { UsageThrottle, UsageThrottledError } from './throttle';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** Default parallelism — small, per the brief ("default small e.g. 3-4"). */
export const DEFAULT_CONCURRENCY = 3;

export interface ClaudeQueueOptions {
  readonly concurrency?: number;
  readonly throttle?: UsageThrottle;
}

interface Pending {
  readonly spec: JobSpec;
  readonly resolve: (result: JobResult) => void;
  readonly reject: (error: unknown) => void;
}

export class ClaudeJobQueue {
  private readonly runner: ClaudeRunner;
  private readonly concurrency: number;
  private readonly throttle: UsageThrottle;
  private readonly waiting: Pending[] = [];
  private active = 0;

  constructor(runner: ClaudeRunner, options: ClaudeQueueOptions = {}) {
    this.runner = runner;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.throttle = options.throttle ?? new UsageThrottle();
    // Subscription guard: warn (once per process) if the paid API key is set on a claude-using path.
    warnIfAnthropicApiKeySetOnce();
  }

  /** Jobs currently running. */
  activeCount(): number {
    return this.active;
  }

  /** Jobs waiting for a slot. */
  pendingCount(): number {
    return this.waiting.length;
  }

  /**
   * Enqueue a job. Resolves with its {@link JobResult}, or rejects with {@link UsageThrottledError}
   * if a deferrable job is refused by the usage-throttle gate, or with the runner's error on spawn
   * failure. The throttle gate is applied at DISPATCH time (not enqueue time) so a long-running batch
   * reflects usage accumulated by earlier jobs in the same batch.
   */
  enqueue(spec: JobSpec): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      this.waiting.push({ spec, resolve, reject });
      this.pump();
    });
  }

  /** Convenience: enqueue many and await all (rejections preserved per-item via allSettled upstream). */
  enqueueAll(specs: readonly JobSpec[]): Promise<JobResult>[] {
    return specs.map((spec) => this.enqueue(spec));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) {
        return;
      }
      this.dispatch(next);
    }
  }

  private dispatch(pending: Pending): void {
    const { spec, resolve, reject } = pending;

    // Usage-throttle gate at dispatch time. Deferrable + over the throttle ⇒ refuse without spawning.
    const decision = this.throttle.check(spec.taskKind);
    if (!decision.allowed) {
      reject(new UsageThrottledError(spec.taskKind, decision));
      // No slot was consumed; try to fill the freed capacity with the next waiter.
      queueMicrotask(() => this.pump());
      return;
    }

    this.active += 1;
    this.runner
      .run(spec)
      .then((result) => {
        this.throttle.record(spec.taskKind, result);
        resolve(result);
      })
      .catch((error: unknown) => {
        reject(error);
      })
      .finally(() => {
        this.active -= 1;
        this.pump();
      });
  }
}
