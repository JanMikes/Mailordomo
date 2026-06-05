/**
 * SMOKE — the PURE overdue-nudge TRIGGER predicate (PROJECT.md §6 / Golden rule #1). Thin coverage;
 * the SEPARATE test-author proves the full trigger matrix + the saveDraft-only draft path. Here we
 * pin the load-bearing gate: the nudge fires for EXACTLY a lapsed INBOUND promise (awaiting-them +
 * overdue) and for nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { PromiseRecord } from '@mailordomo/shared';
import { selectNudgeable, shouldNudge, shouldNudgeAt } from './overdue-nudge';

function promise(over: Partial<PromiseRecord>): PromiseRecord {
  return {
    id: 'p',
    thread_id: 't',
    direction: 'awaiting-them',
    text: 'they send the contract',
    due_at: '2026-06-01T00:00:00Z',
    due_raw: null,
    status: 'overdue',
    actor: 'claude',
    created_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

describe('shouldNudge — fires only on a lapsed inbound (awaiting-them + overdue)', () => {
  it('true for awaiting-them + overdue', () => {
    expect(shouldNudge(promise({}))).toBe(true);
  });
  it('false for any other direction, even if overdue', () => {
    expect(shouldNudge(promise({ direction: 'my-promise' }))).toBe(false);
    expect(shouldNudge(promise({ direction: 'they-asked' }))).toBe(false);
  });
  it('false for awaiting-them in any non-overdue status', () => {
    for (const status of ['open', 'fulfilled', 'cancelled'] as const) {
      expect(shouldNudge(promise({ status }))).toBe(false);
    }
  });
});

describe('shouldNudgeAt — recomputes lapsed-ness from due_at + now', () => {
  const now = '2026-06-05T00:00:00Z';
  it('true when awaiting-them, open, and due_at has passed', () => {
    expect(shouldNudgeAt(promise({ status: 'open' }), now)).toBe(true);
  });
  it('false when due is in the future', () => {
    expect(shouldNudgeAt(promise({ status: 'open', due_at: '2026-06-10T00:00:00Z' }), now)).toBe(
      false,
    );
  });
  it('false when already fulfilled/cancelled regardless of due', () => {
    expect(shouldNudgeAt(promise({ status: 'fulfilled' }), now)).toBe(false);
    expect(shouldNudgeAt(promise({ status: 'cancelled' }), now)).toBe(false);
  });
  it('false when no resolved deadline and not yet flagged overdue', () => {
    expect(shouldNudgeAt(promise({ status: 'open', due_at: null }), now)).toBe(false);
  });
});

describe('selectNudgeable — filters a set to the nudge-worthy promises', () => {
  it('keeps only lapsed inbound promises', () => {
    const set = [
      promise({ id: 'a' }), // awaiting-them + overdue → keep
      promise({ id: 'b', direction: 'my-promise' }),
      promise({ id: 'c', status: 'open' }),
    ];
    expect(selectNudgeable(set).map((p) => p.id)).toEqual(['a']);
  });
});
