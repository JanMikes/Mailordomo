/**
 * Per-call USAGE logging + a rolling-window usage THROTTLE with BACKPRESSURE (PROJECT.md §4
 * "job runner notes", PLAN.md D24).
 *
 * WHY THIS IS A THROTTLE, NOT A MONEY BUDGET: Mailordomo runs the `claude` binary under the user's
 * Claude SUBSCRIPTION (a shared rolling ~5-hour usage window + a weekly cap), NOT pay-per-token API
 * billing. So the real risk is not a dollar bill — it is the BACKGROUND DAEMON exhausting the shared
 * subscription window and starving the user's own interactive Claude Code work. We therefore throttle
 * NOTIONAL USAGE over a rolling window aligned to the subscription window.
 *
 * The signal: each call's reported `total_cost_usd` is kept PURELY as a notional-usage proxy — it is
 * ~proportional to tokens and so approximates how much of the subscription window a call consumed. It
 * is NOT a real charge under a subscription; do not read it as money.
 *
 * Policy (kept simple + testable):
 *  - Record each call's notional usage as a TIMESTAMPED entry.
 *  - "Current usage" = the sum of entries in the rolling window `[now - windowHours, now]`; older
 *    entries are pruned (the window slides as time passes).
 *  - The throttle is `CLAUDE_USAGE_THROTTLE` (default 2.50 notional units) over `CLAUDE_USAGE_WINDOW_HOURS`
 *    (default 5h).
 *  - When current usage is at/over the throttle, ESSENTIAL jobs (triage on new mail) still proceed with a
 *    logged "allow-over-throttle" warning; DEFERRABLE jobs (summaries/digest/ranking) are refused
 *    (backpressure protects the shared window).
 *
 * Everything non-deterministic is INJECTED: the clock (→ window bounds + log times) and the usage
 * window store (→ where the timestamped entries live). Tests pass a fixed clock + in-memory window and
 * assert the exact gate decision, with no wall-clock or env dependency. The window math itself is pure.
 */
import type { TaskKind } from '@mailordomo/shared';
import type { JobResult } from './types';

/** Default notional-usage ceiling per rolling window when `CLAUDE_USAGE_THROTTLE` is unset (PLAN.md D24). */
export const DEFAULT_USAGE_THROTTLE = 2.5;

/** Default rolling-window length in hours when `CLAUDE_USAGE_WINDOW_HOURS` is unset — the subscription's ~5h window. */
export const DEFAULT_USAGE_WINDOW_HOURS = 5;

/**
 * Which task kinds are ESSENTIAL (allowed to run over the throttle with a warning) vs deferrable.
 * Triage runs on every new inbound message and gates the whole pipeline — starving it would stall
 * state inference, so it is essential. Outgoing-text kinds (`draft`/`nudge`/`repo-answer`) are
 * user-initiated on signal, so over-throttle they should also surface rather than be silently dropped;
 * the deferrable set is the BACKGROUND, non-interactive synthesis work (`summarize`/`digest`/`rank`).
 */
export const ESSENTIAL_TASK_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'triage',
  'promise-extraction',
  'draft',
  'nudge',
  'repo-answer',
]);

/** True iff a task kind may proceed even when the usage window is over the throttle. */
export function isEssentialTask(kind: TaskKind): boolean {
  return ESSENTIAL_TASK_KINDS.has(kind);
}

/** Injectable clock — only `now()` is needed (window bounds + log timestamps). */
export interface Clock {
  now(): Date;
}

/** The real clock. */
export const systemClock: Clock = { now: () => new Date() };

/** Convert a window length in hours to milliseconds. */
export function windowMs(windowHours: number): number {
  return windowHours * 60 * 60 * 1000;
}

/** A single timestamped notional-usage entry (one `claude` call's reported usage). */
export interface UsageEntry {
  /** Epoch milliseconds the call was recorded (from the injected clock). */
  readonly at: number;
  /** Notional usage units consumed (the call's `total_cost_usd`, used as a window-share proxy). */
  readonly usage: number;
}

/**
 * Where the rolling window of timestamped usage entries lives. The default is in-memory; a future impl
 * could persist to the cache DB so the window survives a restart. Pure + injectable so tests assert
 * the exact accumulation + pruning. `windowStart` is inclusive (`>= windowStart` is "in window").
 */
export interface UsageWindowStore {
  /** Record a notional-usage entry at epoch-ms `at`. */
  add(at: number, usage: number): void;
  /** Sum of usage for entries with `at >= windowStart`. Implementations may prune older entries here. */
  usageSince(windowStart: number): number;
}

/** Simple in-memory rolling-window store (per-process). Prunes entries that fall out of the window. */
export class InMemoryUsageWindow implements UsageWindowStore {
  private entries: UsageEntry[] = [];

  add(at: number, usage: number): void {
    this.entries.push({ at, usage });
  }

  usageSince(windowStart: number): number {
    // Prune anything that has aged out of the window, then sum what remains. Pure window math.
    this.entries = this.entries.filter((entry) => entry.at >= windowStart);
    let total = 0;
    for (const entry of this.entries) {
      total += entry.usage;
    }
    return total;
  }

  /** Current number of in-memory entries (exposed for assertions/diagnostics; not part of the contract). */
  size(): number {
    return this.entries.length;
  }
}

/** A structured log line per call/decision — emitted through the injectable sink. */
export interface UsageLogEntry {
  readonly at: string;
  readonly taskKind: TaskKind;
  /** `usage` ⇒ a recorded call; `allow-over-throttle` ⇒ essential job allowed past the throttle; `deny-over-throttle` ⇒ deferrable job refused. */
  readonly event: 'usage' | 'allow-over-throttle' | 'deny-over-throttle';
  /** This call's notional usage (present on the `usage` event). NOT a dollar charge — a window-share proxy. */
  readonly usage?: number;
  /** Notional usage currently in the rolling window. */
  readonly windowUsage: number;
  /** The configured notional throttle for the window. */
  readonly throttle: number;
  readonly windowHours: number;
  readonly model?: string;
}

/** Log sink seam — defaults to `console`; tests capture entries instead. */
export type UsageLogger = (entry: UsageLogEntry) => void;

const defaultLogger: UsageLogger = (entry) => {
  // The runner's per-call USAGE log is intentional stdout (no `no-console` rule is configured). This
  // is a usage signal (subscription window share), not a spend/charge line.
  console.info(`[claude-usage] ${JSON.stringify(entry)}`);
};

/** The gate verdict for a prospective job. */
export interface ThrottleDecision {
  readonly allowed: boolean;
  /** `over-throttle-essential` ⇒ allowed with a warning; `over-throttle-deferred` ⇒ refused. */
  readonly reason: 'within-throttle' | 'over-throttle-essential' | 'over-throttle-deferred';
  /** Notional usage currently in the rolling window. */
  readonly windowUsage: number;
  /** The configured notional throttle for the window. */
  readonly throttle: number;
  readonly windowHours: number;
}

export interface UsageThrottleOptions {
  /** Notional usage ceiling per rolling window. Default {@link DEFAULT_USAGE_THROTTLE}. */
  readonly throttle?: number;
  /** Rolling-window length in hours, aligned to the subscription window. Default {@link DEFAULT_USAGE_WINDOW_HOURS}. */
  readonly windowHours?: number;
  readonly clock?: Clock;
  readonly store?: UsageWindowStore;
  readonly logger?: UsageLogger;
}

/**
 * Tracks NOTIONAL Claude usage over a rolling window aligned to the subscription window and decides
 * whether a prospective job may run. The runner/queue calls `check(kind)` BEFORE dispatch and
 * `record(result)` AFTER each call. Pure aside from the injected clock/store/logger — no env read
 * here (config is passed in; see {@link throttleConfigFromEnv}).
 */
export class UsageThrottle {
  private readonly throttle: number;
  private readonly windowHours: number;
  private readonly clock: Clock;
  private readonly store: UsageWindowStore;
  private readonly logger: UsageLogger;

  constructor(options: UsageThrottleOptions = {}) {
    this.throttle = options.throttle ?? DEFAULT_USAGE_THROTTLE;
    this.windowHours = options.windowHours ?? DEFAULT_USAGE_WINDOW_HOURS;
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? new InMemoryUsageWindow();
    this.logger = options.logger ?? defaultLogger;
  }

  /** Start of the current rolling window (epoch ms), i.e. `now - windowHours`. */
  private windowStart(now: Date): number {
    return now.getTime() - windowMs(this.windowHours);
  }

  /** Notional usage currently inside the rolling window, per the injected clock. */
  usageInWindow(): number {
    return this.store.usageSince(this.windowStart(this.clock.now()));
  }

  /** The configured notional throttle (usage units per window). */
  limit(): number {
    return this.throttle;
  }

  /** The configured rolling-window length in hours. */
  windowLengthHours(): number {
    return this.windowHours;
  }

  /**
   * Gate a prospective job. Essential kinds are allowed over the throttle (logged warning); deferrable
   * kinds are refused once the window's usage reaches the throttle (backpressure on the shared window).
   */
  check(taskKind: TaskKind): ThrottleDecision {
    const now = this.clock.now();
    const windowUsage = this.store.usageSince(this.windowStart(now));
    const overThrottle = windowUsage >= this.throttle;

    if (!overThrottle) {
      return {
        allowed: true,
        reason: 'within-throttle',
        windowUsage,
        throttle: this.throttle,
        windowHours: this.windowHours,
      };
    }

    if (isEssentialTask(taskKind)) {
      this.logger({
        at: now.toISOString(),
        taskKind,
        event: 'allow-over-throttle',
        windowUsage,
        throttle: this.throttle,
        windowHours: this.windowHours,
      });
      return {
        allowed: true,
        reason: 'over-throttle-essential',
        windowUsage,
        throttle: this.throttle,
        windowHours: this.windowHours,
      };
    }

    this.logger({
      at: now.toISOString(),
      taskKind,
      event: 'deny-over-throttle',
      windowUsage,
      throttle: this.throttle,
      windowHours: this.windowHours,
    });
    return {
      allowed: false,
      reason: 'over-throttle-deferred',
      windowUsage,
      throttle: this.throttle,
      windowHours: this.windowHours,
    };
  }

  /**
   * Record a completed call's notional usage; append a timestamped entry to the rolling window and log
   * the usage line. Returns the window's usage AFTER adding this call. `costUsd` is the notional-usage
   * proxy (window share), not a dollar charge.
   */
  record(taskKind: TaskKind, result: Pick<JobResult, 'costUsd' | 'model'>): number {
    const now = this.clock.now();
    this.store.add(now.getTime(), result.costUsd);
    const windowUsage = this.store.usageSince(this.windowStart(now));
    this.logger({
      at: now.toISOString(),
      taskKind,
      event: 'usage',
      usage: result.costUsd,
      windowUsage,
      throttle: this.throttle,
      windowHours: this.windowHours,
      ...(result.model !== undefined ? { model: result.model } : {}),
    });
    return windowUsage;
  }
}

/** The resolved throttle config (notional limit + window length) read from the environment. */
export interface ThrottleConfig {
  readonly throttle: number;
  readonly windowHours: number;
}

/**
 * Read the usage-throttle config from the environment, falling back to defaults on unset/invalid:
 *  - `CLAUDE_USAGE_THROTTLE`     → notional usage limit per window (default {@link DEFAULT_USAGE_THROTTLE}).
 *  - `CLAUDE_USAGE_WINDOW_HOURS` → rolling-window length in hours (default {@link DEFAULT_USAGE_WINDOW_HOURS}).
 * Replaces the old `CLAUDE_DAILY_BUDGET_USD` (which framed this as money — it is not under a subscription).
 */
export function throttleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ThrottleConfig {
  return {
    // The throttle ceiling may be 0 (a fully-closed gate — always throttled — is intentional).
    throttle: parseNumericEnv(env.CLAUDE_USAGE_THROTTLE, DEFAULT_USAGE_THROTTLE),
    // The window length must be strictly positive: 0 makes the window empty (start == now), so the
    // throttle would never fire — a silent misconfiguration. Fall back to the default instead.
    windowHours: parseNumericEnv(env.CLAUDE_USAGE_WINDOW_HOURS, DEFAULT_USAGE_WINDOW_HOURS, {
      requirePositive: true,
    }),
  };
}

/**
 * Parse a finite number from an env string, returning `fallback` on unset/blank/invalid/negative.
 * By default 0 is accepted (non-negative); pass `requirePositive` to reject 0 too.
 */
function parseNumericEnv(
  raw: string | undefined,
  fallback: number,
  { requirePositive = false }: { requirePositive?: boolean } = {},
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  const valid = Number.isFinite(parsed) && (requirePositive ? parsed > 0 : parsed >= 0);
  return valid ? parsed : fallback;
}

/** Thrown by the queue/runner when a deferrable job is refused by the usage-throttle gate. */
export class UsageThrottledError extends Error {
  constructor(
    readonly taskKind: TaskKind,
    readonly decision: ThrottleDecision,
  ) {
    super(
      `Claude usage throttle reached (${decision.windowUsage.toFixed(4)} ≥ ${decision.throttle.toFixed(
        2,
      )} notional units in the last ${decision.windowHours}h); deferring non-essential task "${taskKind}" ` +
        `to protect the shared subscription window`,
    );
    this.name = 'UsageThrottledError';
  }
}
