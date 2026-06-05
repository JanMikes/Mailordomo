/**
 * INTENT-DERIVED suite for the overdue-nudge TRIGGER predicate (PROJECT.md §6 / Golden rule #1). The
 * daemon may auto-draft EXACTLY ONE thing unprompted: a chase for a lapsed INBOUND promise (someone
 * promised ME and the deadline passed). This pins that gate by SWEEPING the full direction × status
 * space so nothing else can ever trip it. Complements `overdue-nudge.smoke.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PROMISE_DIRECTIONS, PROMISE_STATUSES } from '@mailordomo/shared';
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

describe('shouldNudge — EXACTLY one of the 12 direction×status combos fires', () => {
  for (const direction of PROMISE_DIRECTIONS) {
    for (const status of PROMISE_STATUSES) {
      const expected = direction === 'awaiting-them' && status === 'overdue';
      it(`${direction} + ${status} → ${expected}`, () => {
        expect(shouldNudge({ direction, status })).toBe(expected);
      });
    }
  }
});

describe('shouldNudgeAt — recompute lapsed-ness from due_at + injected now', () => {
  const now = '2026-06-05T00:00:00Z';

  it.each([
    ['open, due strictly in the past', 'open', '2026-06-01T00:00:00Z', true],
    ['open, due 1ms in the past', 'open', '2026-06-04T23:59:59.999Z', true],
    ['open, due exactly == now (not < now)', 'open', now, false],
    ['open, due in the future', 'open', '2026-06-10T00:00:00Z', false],
    ['open, no resolved deadline', 'open', null, false],
    ['already-flagged overdue, no deadline', 'overdue', null, true],
    [
      'already-flagged overdue, even with a future deadline',
      'overdue',
      '2026-06-10T00:00:00Z',
      true,
    ],
    [
      'fulfilled is terminal, even with a passed deadline',
      'fulfilled',
      '2026-06-01T00:00:00Z',
      false,
    ],
    [
      'cancelled is terminal, even with a passed deadline',
      'cancelled',
      '2026-06-01T00:00:00Z',
      false,
    ],
  ] as const)('awaiting-them: %s → %s', (_label, status, due_at, expected) => {
    expect(shouldNudgeAt(promise({ status, due_at }), now)).toBe(expected);
  });

  it('never fires for an outbound direction, however overdue', () => {
    expect(shouldNudgeAt(promise({ direction: 'my-promise', status: 'open' }), now)).toBe(false);
    expect(shouldNudgeAt(promise({ direction: 'they-asked', status: 'open' }), now)).toBe(false);
  });
});

describe('selectNudgeable — keeps only the lapsed inbound promises from a mixed set', () => {
  it('filters a realistic batch down to awaiting-them + overdue', () => {
    const set = [
      promise({ id: 'keep-1' }), // awaiting-them + overdue
      promise({ id: 'keep-2', text: 'design files' }), // awaiting-them + overdue
      promise({ id: 'drop-open', status: 'open' }), // not lapsed
      promise({ id: 'drop-fulfilled', status: 'fulfilled' }), // resolved
      promise({ id: 'drop-mine', direction: 'my-promise' }), // outbound
      promise({ id: 'drop-asked', direction: 'they-asked' }), // outbound
    ];
    expect(selectNudgeable(set).map((p) => p.id)).toEqual(['keep-1', 'keep-2']);
  });
});
