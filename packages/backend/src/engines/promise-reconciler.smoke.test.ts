/**
 * SMOKE — the deterministic 3-way reconciler (PROJECT.md §7). Thin coverage only; the SEPARATE
 * test-author writes the full load-bearing suite (exhaustive bucketing, status transitions, deadline
 * anchoring across DST, fallback resolver). Here we just prove the pure transform wires together:
 * bucketing honors who/whom over a bad hint, status follows signal/overdue, and the deterministic
 * fallback resolves a relative deadline when the model gave none.
 */
import { describe, expect, it } from 'vitest';
import type { PromiseCandidate } from '../claude/promise-extraction-schema';
import {
  bucketDirection,
  deriveStatus,
  groupByDirection,
  reconcileCandidates,
  reconcileExisting,
  resolveDueAt,
} from './promise-reconciler';

function candidate(overrides: Partial<PromiseCandidate> = {}): PromiseCandidate {
  return {
    direction_hint: 'my-promise',
    text: 'Send the v2 API spec',
    due_raw: null,
    due_at: null,
    who: 'me',
    whom: 'Petr',
    fulfillment_signal: 'none',
    confidence: 'high',
    ...overrides,
  };
}

let counter = 0;
const newId = (): string => `p${(counter += 1)}`;

describe('bucketDirection — who/whom override a contradicting hint', () => {
  it('me→other forces my-promise even if the hint said otherwise', () => {
    expect(
      bucketDirection(candidate({ direction_hint: 'awaiting-them', who: 'me', whom: 'Petr' })),
    ).toBe('my-promise');
  });
  it('other→me forces awaiting-them even if the hint said they-asked', () => {
    expect(
      bucketDirection(candidate({ direction_hint: 'they-asked', who: 'Petr', whom: 'me' })),
    ).toBe('awaiting-them');
  });
  it('ambiguous who/whom keeps the hint', () => {
    expect(
      bucketDirection(candidate({ direction_hint: 'they-asked', who: 'Petr', whom: 'Petr' })),
    ).toBe('they-asked');
  });
});

describe('deriveStatus — the §7 lifecycle', () => {
  const now = '2026-06-05T12:00:00Z';
  it('explicit fulfilled/cancelled signals win', () => {
    expect(deriveStatus('fulfilled', '2026-06-01T00:00:00Z', now)).toBe('fulfilled');
    expect(deriveStatus('cancelled', null, now)).toBe('cancelled');
  });
  it('overdue when a resolved due_at is in the past and still open', () => {
    expect(deriveStatus('none', '2026-06-01T00:00:00Z', now)).toBe('overdue');
  });
  it('open when due is in the future or absent', () => {
    expect(deriveStatus('none', '2026-06-10T00:00:00Z', now)).toBe('open');
    expect(deriveStatus('none', null, now)).toBe('open');
  });
});

describe('resolveDueAt — trust the model ISO, else fall back to the deterministic resolver', () => {
  const received = '2026-06-01T08:00:00+02:00'; // a Monday in Prague summer
  it('trusts a valid model due_at', () => {
    const out = resolveDueAt({ due_at: '2026-06-12T15:30:00Z', due_raw: 'next Friday' }, received);
    expect(out).toBe('2026-06-12T15:30:00.000Z');
  });
  it('falls back to resolving due_raw when due_at is null', () => {
    const out = resolveDueAt({ due_at: null, due_raw: 'by Friday' }, received);
    // The Friday on/after Mon Jun 1 is Fri Jun 5; end of day Prague (CEST, +02:00) = 21:59:59Z.
    expect(out).toBe('2026-06-05T21:59:59.000Z');
  });
  it('returns null when neither is usable', () => {
    expect(resolveDueAt({ due_at: null, due_raw: null }, received)).toBeNull();
    expect(resolveDueAt({ due_at: null, due_raw: 'whenever-ish' }, received)).toBeNull();
  });
});

describe('reconcileCandidates — candidate[] → PromiseRecord[]', () => {
  it('produces one record per candidate with bucketed direction + resolved due + status', () => {
    const records = reconcileCandidates(
      [
        candidate({ who: 'me', whom: 'Petr', due_raw: 'by Friday', direction_hint: 'my-promise' }),
        candidate({
          text: 'Petr sends the contract',
          who: 'Petr',
          whom: 'me',
          due_at: '2026-06-01T00:00:00Z',
          direction_hint: 'awaiting-them',
        }),
      ],
      {
        threadId: 't1',
        messageReceivedIso: '2026-06-02T08:00:00+02:00', // a Tuesday
        nowIso: '2026-06-05T12:00:00Z',
        newId,
      },
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.direction).toBe('my-promise');
    expect(records[0]?.due_raw).toBe('by Friday');
    expect(records[0]?.due_at).not.toBeNull();
    // The contract was due Jun 1 (before now Jun 5) → overdue, and it is awaiting-them (inbound).
    expect(records[1]?.direction).toBe('awaiting-them');
    expect(records[1]?.status).toBe('overdue');
  });

  it('drops candidates below the configured confidence floor', () => {
    const records = reconcileCandidates([candidate({ confidence: 'low' })], {
      threadId: 't1',
      messageReceivedIso: '2026-06-02T08:00:00Z',
      nowIso: '2026-06-05T12:00:00Z',
      newId,
      minConfidence: 'medium',
    });
    expect(records).toHaveLength(0);
  });
});

describe('reconcileExisting — open→overdue on a passed deadline, terminals untouched', () => {
  const base = {
    id: 'p1',
    thread_id: 't1',
    direction: 'awaiting-them' as const,
    text: 'x',
    due_raw: null,
    actor: 'claude',
    created_at: '2026-06-01T00:00:00Z',
  };
  it('flips open → overdue when due_at passed', () => {
    const out = reconcileExisting(
      [{ ...base, due_at: '2026-06-01T00:00:00Z', status: 'open' }],
      '2026-06-05T00:00:00Z',
    );
    expect(out[0]?.status).toBe('overdue');
  });
  it('leaves fulfilled/cancelled untouched', () => {
    const out = reconcileExisting(
      [{ ...base, due_at: '2026-06-01T00:00:00Z', status: 'fulfilled' }],
      '2026-06-05T00:00:00Z',
    );
    expect(out[0]?.status).toBe('fulfilled');
  });
});

describe('groupByDirection — the 3-way buckets', () => {
  it('splits records into the three columns', () => {
    const records = reconcileCandidates(
      [
        candidate({ who: 'me', whom: 'P' }),
        candidate({ text: 'they asked', who: 'P', whom: 'P', direction_hint: 'they-asked' }),
        candidate({ text: 'awaiting', who: 'P', whom: 'me' }),
      ],
      {
        threadId: 't',
        messageReceivedIso: '2026-06-02T08:00:00Z',
        nowIso: '2026-06-05T12:00:00Z',
        newId,
      },
    );
    const buckets = groupByDirection(records);
    expect(buckets.myPromises).toHaveLength(1);
    expect(buckets.theyAsked).toHaveLength(1);
    expect(buckets.awaitingThem).toHaveLength(1);
  });
});
