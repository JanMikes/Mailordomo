/**
 * INTENT-DERIVED suite for stale-thread DETECTION (PROJECT.md §6/§9 + §8 step 3). Derived from the
 * spec: `done` is never stale; an elapsed follow-up/hard deadline is the strongest signal in any
 * non-done state; `follow-up` is act-now; `waiting`/`needs-reply`/`drafted` go stale after a
 * state-specific silence. Complements `stale.smoke.test.ts` with EXACT ±1ms threshold boundaries,
 * the done-beats-a-passed-deadline ordering, custom thresholds, and null-activity behavior.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_NEEDS_REPLY_STALE_DAYS, DEFAULT_WAITING_STALE_DAYS, detectStale } from './stale';

const NOW = '2026-06-10T12:00:00Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(NOW_MS - ms).toISOString();

describe('done is never stale (no work owed) — even against signals that flag any other state', () => {
  it('stays not-stale with ancient activity AND a long-passed deadline AND follow-up', () => {
    const v = detectStale(
      {
        state: 'done',
        lastActivityIso: ago(100 * DAY),
        deadlineIso: ago(50 * DAY),
        followUpAtIso: ago(50 * DAY),
      },
      NOW,
    );
    expect(v.stale).toBe(false);
    expect(v.reason).toBeUndefined();
  });
});

describe('an elapsed follow-up OR hard deadline makes ANY non-done state stale', () => {
  it.each(['needs-reply', 'drafted', 'waiting', 'follow-up'] as const)(
    '%s + a passed hard deadline → stale (follow-up-deadline-passed)',
    (state) => {
      const v = detectStale({ state, lastActivityIso: ago(0), deadlineIso: ago(DAY) }, NOW);
      expect(v.stale).toBe(true);
      expect(v.reason).toBe('follow-up-deadline-passed');
    },
  );

  it('a passed follow-up time triggers the same way', () => {
    expect(
      detectStale({ state: 'waiting', lastActivityIso: ago(0), followUpAtIso: ago(DAY) }, NOW)
        .reason,
    ).toBe('follow-up-deadline-passed');
  });

  it('a FUTURE deadline/follow-up does NOT trigger (only elapsed ones do)', () => {
    const v = detectStale(
      {
        state: 'waiting',
        lastActivityIso: ago(0),
        deadlineIso: ago(-DAY),
        followUpAtIso: ago(-DAY),
      },
      NOW,
    );
    expect(v.stale).toBe(false);
  });
});

describe('follow-up is act-now stale regardless of age (it IS the "go chase it" state)', () => {
  it('is stale with brand-new activity', () => {
    expect(detectStale({ state: 'follow-up', lastActivityIso: ago(0) }, NOW).reason).toBe(
      'in-follow-up-state',
    );
  });
});

describe('silence thresholds fire at the boundary (>= threshold), not a millisecond before', () => {
  it(`waiting: stale at exactly ${DEFAULT_WAITING_STALE_DAYS}d of silence, not 1ms under`, () => {
    const threshold = DEFAULT_WAITING_STALE_DAYS * DAY;
    expect(detectStale({ state: 'waiting', lastActivityIso: ago(threshold - 1) }, NOW).stale).toBe(
      false,
    );
    const v = detectStale({ state: 'waiting', lastActivityIso: ago(threshold) }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('awaiting-reply-too-long');
  });

  it.each(['needs-reply', 'drafted'] as const)(
    `%s: stale at exactly ${DEFAULT_NEEDS_REPLY_STALE_DAYS}d, not 1ms under`,
    (state) => {
      const threshold = DEFAULT_NEEDS_REPLY_STALE_DAYS * DAY;
      expect(detectStale({ state, lastActivityIso: ago(threshold - 1) }, NOW).stale).toBe(false);
      const v = detectStale({ state, lastActivityIso: ago(threshold) }, NOW);
      expect(v.stale).toBe(true);
      expect(v.reason).toBe('unanswered-too-long');
    },
  );

  it('respects caller-supplied thresholds over the defaults', () => {
    const opts = { waitingStaleDays: 7, needsReplyStaleDays: 1 };
    expect(detectStale({ state: 'waiting', lastActivityIso: ago(6 * DAY) }, NOW, opts).stale).toBe(
      false,
    );
    expect(detectStale({ state: 'waiting', lastActivityIso: ago(7 * DAY) }, NOW, opts).stale).toBe(
      true,
    );
    expect(detectStale({ state: 'needs-reply', lastActivityIso: ago(DAY) }, NOW, opts).stale).toBe(
      true,
    );
  });
});

describe('unknown (null) last-activity', () => {
  it('a silence-threshold state cannot be judged stale without an age → not stale, ageMs null', () => {
    const v = detectStale({ state: 'waiting', lastActivityIso: null }, NOW);
    expect(v.stale).toBe(false);
    expect(v.ageMs).toBeNull();
  });

  it('but follow-up is still act-now stale (its verdict does not depend on age)', () => {
    const v = detectStale({ state: 'follow-up', lastActivityIso: null }, NOW);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('in-follow-up-state');
    expect(v.ageMs).toBeNull();
  });
});
