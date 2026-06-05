/**
 * LOAD-BEARING — Usage THROTTLE (PROJECT.md §4 "usage throttle, not a money budget" + PLAN.md D24).
 *
 * Derived from §4/D24 INTENT, NOT the code:
 *   - Mailordomo runs `claude` under the user's SUBSCRIPTION (shared rolling ~5h window + weekly
 *     cap), so the guard is a USAGE throttle over a rolling window — not a dollar budget. Each
 *     call's `total_cost_usd` is kept purely as a NOTIONAL usage signal.
 *   - Rolling-window math: only entries inside `[now - windowHours, now]` count; older entries age
 *     out as the window slides; the boundary at exactly `windowStart` is INCLUSIVE.
 *   - Backpressure: over the throttle, ESSENTIAL kinds (triage/promise-extraction/draft/nudge/
 *     repo-answer) still proceed (with a logged warning); DEFERRABLE kinds (summarize/digest/rank)
 *     are refused. Essential = the pipeline must not starve; deferrable = background synthesis.
 *   - `throttleConfigFromEnv` reads CLAUDE_USAGE_THROTTLE / CLAUDE_USAGE_WINDOW_HOURS, defaulting
 *     (2.50 / 5) on blank/invalid/negative.
 *
 * Everything non-deterministic is INJECTED (clock, store, logger) so there is no wall-clock/env dep.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TaskKind } from '@mailordomo/shared';
import {
  DEFAULT_USAGE_THROTTLE,
  DEFAULT_USAGE_WINDOW_HOURS,
  ESSENTIAL_TASK_KINDS,
  InMemoryUsageWindow,
  isEssentialTask,
  throttleConfigFromEnv,
  UsageThrottle,
  UsageThrottledError,
  windowMs,
} from './throttle';
import type { Clock, UsageLogEntry } from './throttle';
import { ClaudeJobQueue } from './queue';
import { FakeClaudeRunner } from './fake-runner';

/** A clock whose `now()` is whatever `t` is set to — advance it to age entries out. */
class FakeClock implements Clock {
  constructor(private t: number) {}
  set(ms: number): void {
    this.t = ms;
  }
  advanceHours(h: number): void {
    this.t += h * 60 * 60 * 1000;
  }
  now(): Date {
    return new Date(this.t);
  }
}

const T0 = Date.parse('2026-06-05T10:00:00Z');

describe('rolling-window math — entries inside vs outside [now - windowHours, now]', () => {
  it('sums only entries inside the window; ages out old ones as the clock advances', () => {
    const clock = new FakeClock(T0);
    const store = new InMemoryUsageWindow();
    const throttle = new UsageThrottle({ windowHours: 5, clock, store, logger: () => {} });

    // Three entries at T0, T0-2h (in), and T0-6h (already out at T0).
    store.add(T0, 1.0);
    store.add(T0 - windowMs(2), 0.5);
    store.add(T0 - windowMs(6), 9.9);
    expect(throttle.usageInWindow()).toBeCloseTo(1.5, 6); // the 6h-old entry is outside

    // Advance 3h → window is [T0-2h, T0+3h]: the T0-2h entry is now exactly at the edge (kept);
    // the T0 entry is inside. Total still 1.5.
    clock.advanceHours(3);
    expect(throttle.usageInWindow()).toBeCloseTo(1.5, 6);

    // Advance 1h more (T0+4h) → window start T0-1h: the T0-2h entry ages out, only T0 remains.
    clock.advanceHours(1);
    expect(throttle.usageInWindow()).toBeCloseTo(1.0, 6);

    // Advance past 5h from T0 → everything ages out.
    clock.set(T0 + windowMs(6));
    expect(throttle.usageInWindow()).toBeCloseTo(0, 6);
  });

  it('the boundary at EXACTLY windowStart is inclusive (>= windowStart counts)', () => {
    const clock = new FakeClock(T0);
    const store = new InMemoryUsageWindow();
    const throttle = new UsageThrottle({ windowHours: 5, clock, store, logger: () => {} });

    const windowStart = T0 - windowMs(5);
    store.add(windowStart, 2.0); // exactly on the boundary → IN
    store.add(windowStart - 1, 4.0); // 1ms older → OUT
    expect(throttle.usageInWindow()).toBeCloseTo(2.0, 6);
  });

  it('record() appends a timestamped entry and returns the window total after adding it', () => {
    const clock = new FakeClock(T0);
    const throttle = new UsageThrottle({ throttle: 5, windowHours: 5, clock, logger: () => {} });
    expect(throttle.record('triage', { costUsd: 1.25, model: 'claude-haiku-4-5' })).toBeCloseTo(
      1.25,
      6,
    );
    expect(throttle.record('summarize', { costUsd: 0.75, model: 'claude-sonnet-4-6' })).toBeCloseTo(
      2.0,
      6,
    );
    expect(throttle.usageInWindow()).toBeCloseTo(2.0, 6);
  });

  it('InMemoryUsageWindow prunes aged-out entries on read (size shrinks)', () => {
    const store = new InMemoryUsageWindow();
    store.add(T0 - windowMs(10), 1);
    store.add(T0, 1);
    expect(store.size()).toBe(2);
    expect(store.usageSince(T0 - windowMs(5))).toBeCloseTo(1, 6);
    expect(store.size()).toBe(1); // the 10h-old entry was pruned
  });
});

describe('essential vs deferrable classification (the backpressure split)', () => {
  it('the ESSENTIAL set is exactly triage/promise-extraction/draft/nudge/repo-answer', () => {
    expect([...ESSENTIAL_TASK_KINDS].sort()).toEqual(
      ['draft', 'nudge', 'promise-extraction', 'repo-answer', 'triage'].sort(),
    );
  });

  it('isEssentialTask is true for essential kinds, false for deferrable synthesis kinds', () => {
    for (const k of [
      'triage',
      'promise-extraction',
      'draft',
      'nudge',
      'repo-answer',
    ] as TaskKind[]) {
      expect(isEssentialTask(k)).toBe(true);
    }
    for (const k of ['summarize', 'digest', 'rank'] as TaskKind[]) {
      expect(isEssentialTask(k)).toBe(false);
    }
  });
});

describe('check() — within throttle: everything is allowed', () => {
  it('allows any kind while usage is under the throttle (no warn log)', () => {
    const clock = new FakeClock(T0);
    const logs: UsageLogEntry[] = [];
    const throttle = new UsageThrottle({
      throttle: 5,
      windowHours: 5,
      clock,
      logger: (e) => logs.push(e),
    });
    throttle.record('triage', { costUsd: 2.0, model: 'm' }); // window 2.0 < 5
    const before = logs.length;
    const d = throttle.check('summarize');
    expect(d).toMatchObject({
      allowed: true,
      reason: 'within-throttle',
      windowUsage: 2.0,
      throttle: 5,
    });
    // check() must not log on the within-throttle path.
    expect(logs.length).toBe(before);
  });
});

describe('check() — over throttle: backpressure matrix (essential allowed+warned, deferrable refused)', () => {
  function atThrottle(logger: (e: UsageLogEntry) => void): UsageThrottle {
    const clock = new FakeClock(T0);
    const t = new UsageThrottle({ throttle: 2.5, windowHours: 5, clock, logger });
    t.record('digest', { costUsd: 2.5, model: 'm' }); // window == throttle → over (>=)
    return t;
  }

  it('ESSENTIAL kinds are allowed over the throttle WITH a logged allow-over-throttle warning', () => {
    for (const kind of [
      'triage',
      'promise-extraction',
      'draft',
      'nudge',
      'repo-answer',
    ] as TaskKind[]) {
      const logs: UsageLogEntry[] = [];
      const d = atThrottle((e) => logs.push(e)).check(kind);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe('over-throttle-essential');
      expect(logs.some((e) => e.event === 'allow-over-throttle' && e.taskKind === kind)).toBe(true);
    }
  });

  it('DEFERRABLE kinds are REFUSED over the throttle with a deny-over-throttle log', () => {
    for (const kind of ['summarize', 'digest', 'rank'] as TaskKind[]) {
      const logs: UsageLogEntry[] = [];
      const d = atThrottle((e) => logs.push(e)).check(kind);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('over-throttle-deferred');
      expect(logs.some((e) => e.event === 'deny-over-throttle' && e.taskKind === kind)).toBe(true);
    }
  });

  it('the over-throttle trigger is >= (reaching the throttle exactly already backpressures)', () => {
    const clock = new FakeClock(T0);
    const t = new UsageThrottle({ throttle: 2.5, windowHours: 5, clock, logger: () => {} });
    t.record('digest', { costUsd: 2.4999, model: 'm' });
    expect(t.check('summarize').allowed).toBe(true); // just under
    t.record('digest', { costUsd: 0.0001, model: 'm' }); // now exactly 2.5
    expect(t.check('summarize').allowed).toBe(false); // at the throttle → refused
  });
});

describe('throttleConfigFromEnv — parses CLAUDE_USAGE_THROTTLE / CLAUDE_USAGE_WINDOW_HOURS', () => {
  it('defaults to 2.50 / 5 when unset', () => {
    expect(throttleConfigFromEnv({})).toEqual({
      throttle: DEFAULT_USAGE_THROTTLE,
      windowHours: DEFAULT_USAGE_WINDOW_HOURS,
    });
    expect(DEFAULT_USAGE_THROTTLE).toBe(2.5);
    expect(DEFAULT_USAGE_WINDOW_HOURS).toBe(5);
  });

  it('parses valid numeric strings', () => {
    expect(
      throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: '7.5', CLAUDE_USAGE_WINDOW_HOURS: '3' }),
    ).toEqual({ throttle: 7.5, windowHours: 3 });
  });

  it('falls back to defaults on blank / invalid / negative values', () => {
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: '' }).throttle).toBe(
      DEFAULT_USAGE_THROTTLE,
    );
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: '   ' }).throttle).toBe(
      DEFAULT_USAGE_THROTTLE,
    );
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: 'abc' }).throttle).toBe(
      DEFAULT_USAGE_THROTTLE,
    );
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: '-1' }).throttle).toBe(
      DEFAULT_USAGE_THROTTLE,
    );
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_WINDOW_HOURS: 'NaN' }).windowHours).toBe(
      DEFAULT_USAGE_WINDOW_HOURS,
    );
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_WINDOW_HOURS: '-5' }).windowHours).toBe(
      DEFAULT_USAGE_WINDOW_HOURS,
    );
  });

  it('accepts 0 as a valid (non-negative) throttle — a fully-closed window is intentional', () => {
    expect(throttleConfigFromEnv({ CLAUDE_USAGE_THROTTLE: '0' }).throttle).toBe(0);
  });
});

describe('queue — usage-throttle backpressure end-to-end (fake runner + injected clock)', () => {
  const fixedClock: Clock = { now: () => new Date(T0) };

  it('records usage and DEFERS a deferrable job once over the throttle; essential still runs', async () => {
    const runner = new FakeClaudeRunner({ fallback: { costUsd: 3.0 } });
    const throttle = new UsageThrottle({ throttle: 5.0, clock: fixedClock, logger: () => {} });
    const queue = new ClaudeJobQueue(runner, { concurrency: 1, throttle });

    await queue.enqueue({ taskKind: 'summarize', prompt: 'a' }); // window 3.0
    await queue.enqueue({ taskKind: 'summarize', prompt: 'b' }); // window 6.0 (>= 5 next time)
    expect(throttle.usageInWindow()).toBeCloseTo(6.0, 6);

    // Over the throttle now: a deferrable summarize is refused with UsageThrottledError…
    await expect(queue.enqueue({ taskKind: 'summarize', prompt: 'c' })).rejects.toBeInstanceOf(
      UsageThrottledError,
    );
    // …but an essential triage proceeds.
    await expect(queue.enqueue({ taskKind: 'triage', prompt: 'd' })).resolves.toBeDefined();
  });

  it('frees the slot on a refused deferrable and KEEPS PUMPING the rest of the batch', async () => {
    // A slow runner so we can observe the queue draining after a refusal mid-batch.
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    const seen: string[] = [];
    const runner: { run: (s: { taskKind: TaskKind; prompt: string }) => Promise<never> } = {
      async run(spec) {
        seen.push(`${spec.taskKind}:${spec.prompt}`);
        await gate; // hold the slot until released
        return { costUsd: 0 } as never;
      },
    };
    const throttle = new UsageThrottle({ throttle: 2.5, clock: fixedClock, logger: () => {} });
    // Pre-load the window to be already over the throttle so deferrables get refused immediately.
    throttle.record('digest', { costUsd: 3.0, model: 'm' });
    const queue = new ClaudeJobQueue(
      runner as unknown as ConstructorParameters<typeof ClaudeJobQueue>[0],
      { concurrency: 1, throttle },
    );

    const refused = queue.enqueue({ taskKind: 'summarize', prompt: 'def' }); // deferrable → refused
    const essential = queue.enqueue({ taskKind: 'triage', prompt: 'ess' }); // essential → runs

    // The deferrable rejects without ever spawning; the essential one is dispatched (slot was free).
    await expect(refused).rejects.toBeInstanceOf(UsageThrottledError);
    // Give the microtask pump a tick, then release the gate so the essential job completes.
    await Promise.resolve();
    resolveGate?.();
    await essential;
    // The runner decrements `active` in a `.finally` that runs on a microtask AFTER `essential`
    // resolves — flush microtasks before asserting the queue has fully drained.
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['triage:ess']); // only the essential job ever reached the runner
    expect(queue.activeCount()).toBe(0);
    expect(queue.pendingCount()).toBe(0);
  });

  it('records total_cost_usd as the NOTIONAL signal via the throttle after each completed call', async () => {
    const logs: UsageLogEntry[] = [];
    const runner = new FakeClaudeRunner({ fallback: { costUsd: 0.4, model: 'claude-haiku-4-5' } });
    const throttle = new UsageThrottle({
      throttle: 5,
      clock: fixedClock,
      logger: (e) => logs.push(e),
    });
    const queue = new ClaudeJobQueue(runner, { concurrency: 2, throttle });
    await Promise.all([
      queue.enqueue({ taskKind: 'triage', prompt: '1' }),
      queue.enqueue({ taskKind: 'triage', prompt: '2' }),
    ]);
    const usageLogs = logs.filter((e) => e.event === 'usage');
    expect(usageLogs).toHaveLength(2);
    expect(usageLogs.every((e) => e.usage === 0.4)).toBe(true);
    expect(throttle.usageInWindow()).toBeCloseTo(0.8, 6);
  });
});

describe('UsageThrottledError — carries the kind + the decision for callers/logs', () => {
  it('names the deferred task and the window/throttle figures', () => {
    const clock = new FakeClock(T0);
    const t = new UsageThrottle({ throttle: 2.5, windowHours: 5, clock, logger: () => {} });
    t.record('digest', { costUsd: 3.0, model: 'm' });
    const decision = t.check('rank');
    const err = new UsageThrottledError('rank', decision);
    expect(err.taskKind).toBe('rank');
    expect(err.decision.allowed).toBe(false);
    expect(err.message).toContain('rank');
    expect(err.message).toMatch(/5h/);
  });
});

describe('default-construction smoke (no injected store/clock) does not read env or wall-clock badly', () => {
  it('a fresh UsageThrottle reports its configured limit/window and an empty window', () => {
    const t = new UsageThrottle({ logger: () => {} });
    expect(t.limit()).toBe(DEFAULT_USAGE_THROTTLE);
    expect(t.windowLengthHours()).toBe(DEFAULT_USAGE_WINDOW_HOURS);
    expect(t.usageInWindow()).toBe(0);
  });

  it('windowMs converts hours to ms', () => {
    expect(windowMs(5)).toBe(5 * 60 * 60 * 1000);
    expect(windowMs(0)).toBe(0);
  });

  // Silence the default console logger if it is ever exercised indirectly.
  it('does not throw when the default logger path runs', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const t = new UsageThrottle({ throttle: 1 });
    t.record('triage', { costUsd: 0.1, model: 'm' });
    t.check('triage');
    spy.mockRestore();
    expect(true).toBe(true);
  });
});
