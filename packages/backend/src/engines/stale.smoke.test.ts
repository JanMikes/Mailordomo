/**
 * SMOKE — stale-thread detection (PROJECT.md §6/§9). Thin coverage; the SEPARATE test-author writes
 * the full threshold matrix. Here we pin: done is never stale, a passed deadline/follow-up is stale
 * regardless of state, `follow-up` is act-now, and the silence thresholds fire per state.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_NEEDS_REPLY_STALE_DAYS, DEFAULT_WAITING_STALE_DAYS, detectStale } from './stale';

const NOW = '2026-06-10T12:00:00Z';
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

describe('detectStale', () => {
  it('done is never stale', () => {
    expect(detectStale({ state: 'done', lastActivityIso: daysAgo(100) }, NOW).stale).toBe(false);
  });

  it('a passed follow-up time is stale regardless of state', () => {
    const v = detectStale(
      { state: 'waiting', lastActivityIso: daysAgo(1), followUpAtIso: daysAgo(1) },
      NOW,
    );
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('follow-up-deadline-passed');
  });

  it('a passed hard deadline is stale', () => {
    const v = detectStale(
      { state: 'needs-reply', lastActivityIso: daysAgo(0), deadlineIso: daysAgo(1) },
      NOW,
    );
    expect(v.reason).toBe('follow-up-deadline-passed');
  });

  it('follow-up state is act-now stale', () => {
    expect(detectStale({ state: 'follow-up', lastActivityIso: daysAgo(0) }, NOW).reason).toBe(
      'in-follow-up-state',
    );
  });

  it('waiting goes stale only past the waiting threshold', () => {
    expect(
      detectStale(
        { state: 'waiting', lastActivityIso: daysAgo(DEFAULT_WAITING_STALE_DAYS - 1) },
        NOW,
      ).stale,
    ).toBe(false);
    const v = detectStale(
      { state: 'waiting', lastActivityIso: daysAgo(DEFAULT_WAITING_STALE_DAYS) },
      NOW,
    );
    expect(v.stale).toBe(true);
    expect(v.reason).toBe('awaiting-reply-too-long');
  });

  it('needs-reply/drafted go stale past the needs-reply threshold', () => {
    expect(
      detectStale(
        { state: 'needs-reply', lastActivityIso: daysAgo(DEFAULT_NEEDS_REPLY_STALE_DAYS - 1) },
        NOW,
      ).stale,
    ).toBe(false);
    expect(
      detectStale(
        { state: 'drafted', lastActivityIso: daysAgo(DEFAULT_NEEDS_REPLY_STALE_DAYS) },
        NOW,
      ).reason,
    ).toBe('unanswered-too-long');
  });

  it('reports age in ms', () => {
    expect(detectStale({ state: 'waiting', lastActivityIso: daysAgo(2) }, NOW).ageMs).toBe(
      2 * 86_400_000,
    );
  });
});
