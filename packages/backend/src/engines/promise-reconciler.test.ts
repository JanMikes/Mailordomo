/**
 * INTENT-DERIVED suite for the 3-way promise RECONCILER (PROJECT.md §7). Written independently of the
 * implementation, from the spec: three directions (my-promise/they-asked/awaiting-them), the status
 * lifecycle `open → fulfilled | overdue | cancelled`, and deadline anchoring. Complements (does not
 * duplicate) `promise-reconciler.smoke.test.ts` with the EXHAUSTIVE bucketing matrix, status-lifecycle
 * boundaries, the never-resurrect guarantee of `reconcileExisting`, and purity.
 *
 * §7 structural fact this suite pins: who(OBLIGOR)/whom(BENEFICIARY) can identify the ONE "they owe me"
 * direction (awaiting-them ⇔ obligor=other, beneficiary=me) but CANNOT separate the two "I owe"
 * directions (my-promise vs they-asked both have obligor=me), so those follow the model's hint.
 */
import { describe, expect, it } from 'vitest';
import type { PromiseDirection, PromiseRecord } from '@mailordomo/shared';
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

function record(overrides: Partial<PromiseRecord> = {}): PromiseRecord {
  return {
    id: 'p1',
    thread_id: 't1',
    direction: 'awaiting-them',
    text: 'they send the contract',
    due_at: null,
    due_raw: null,
    status: 'open',
    actor: 'claude',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

let counter = 0;
const newId = (): string => `p${(counter += 1)}`;

describe('bucketDirection — exhaustive obligor/beneficiary × hint matrix (§7)', () => {
  interface Row {
    readonly hint: PromiseDirection;
    readonly who: string;
    readonly whom: string;
    readonly expected: PromiseDirection;
    readonly why: string;
  }
  // The other party (obligor) owes ME (beneficiary) ⇒ awaiting-them, regardless of the hint — the
  // ONLY "they owe me" direction.
  const otherToMe: Row[] = [
    { hint: 'my-promise', who: 'Petr', whom: 'me', expected: 'awaiting-them', why: 'corrected' },
    { hint: 'they-asked', who: 'Petr', whom: 'me', expected: 'awaiting-them', why: 'corrected' },
    { hint: 'awaiting-them', who: 'Petr', whom: 'me', expected: 'awaiting-them', why: 'agrees' },
  ];
  // I (obligor) owe the other party ⇒ an "I owe" direction; keep the hint when it already is one,
  // but a contradicting `awaiting-them` hint is corrected to the default "I owe" bucket my-promise.
  const meToOther: Row[] = [
    { hint: 'my-promise', who: 'me', whom: 'Petr', expected: 'my-promise', why: 'kept' },
    { hint: 'they-asked', who: 'me', whom: 'Petr', expected: 'they-asked', why: 'kept' },
    { hint: 'awaiting-them', who: 'me', whom: 'Petr', expected: 'my-promise', why: 'corrected' },
  ];
  // Ambiguous (both me, or both other): who/whom cannot decide ⇒ trust the model's hint verbatim.
  const bothMe: Row[] = [
    { hint: 'my-promise', who: 'me', whom: 'me', expected: 'my-promise', why: 'trust hint' },
    { hint: 'they-asked', who: 'me', whom: 'me', expected: 'they-asked', why: 'trust hint' },
    { hint: 'awaiting-them', who: 'me', whom: 'me', expected: 'awaiting-them', why: 'trust hint' },
  ];
  const bothOther: Row[] = [
    { hint: 'my-promise', who: 'Petr', whom: 'Lumír', expected: 'my-promise', why: 'trust hint' },
    { hint: 'they-asked', who: 'Petr', whom: 'Lumír', expected: 'they-asked', why: 'trust hint' },
    { hint: 'awaiting-them', who: 'Petr', whom: 'Lumír', expected: 'awaiting-them', why: 'hint' },
  ];
  const rows = [...otherToMe, ...meToOther, ...bothMe, ...bothOther];

  it.each(rows)(
    'hint=$hint who=$who whom=$whom → $expected ($why)',
    ({ hint, who, whom, expected }) => {
      expect(bucketDirection(candidate({ direction_hint: hint, who, whom }))).toBe(expected);
    },
  );

  it.each(['me', 'Me', 'ME', ' me ', 'I', 'i', 'self', 'myself'])(
    'recognizes %j as the user in who/whom (case/space-insensitive)',
    (selfToken) => {
      // who=self, whom=other ⇒ "I owe" ⇒ keeps a my-promise hint.
      expect(
        bucketDirection(candidate({ who: selfToken, whom: 'Petr', direction_hint: 'my-promise' })),
      ).toBe('my-promise');
      // who=other, whom=self ⇒ awaiting-them even against a my-promise hint.
      expect(
        bucketDirection(candidate({ who: 'Petr', whom: selfToken, direction_hint: 'my-promise' })),
      ).toBe('awaiting-them');
    },
  );
});

describe('deriveStatus — the §7 lifecycle with explicit boundaries', () => {
  const now = '2026-06-05T12:00:00Z';

  it('an explicit fulfilled/cancelled signal wins even over a passed deadline (no overdue)', () => {
    expect(deriveStatus('fulfilled', '2020-01-01T00:00:00Z', now)).toBe('fulfilled');
    expect(deriveStatus('cancelled', '2020-01-01T00:00:00Z', now)).toBe('cancelled');
  });

  it('open → overdue only when a resolved due_at is STRICTLY before now', () => {
    expect(deriveStatus('none', '2026-06-05T11:59:59.999Z', now)).toBe('overdue');
    // Boundary: due_at exactly == now is NOT overdue (the spec is "< now").
    expect(deriveStatus('none', now, now)).toBe('open');
    expect(deriveStatus('none', '2026-06-05T12:00:00.001Z', now)).toBe('open');
  });

  it('open when there is no resolved deadline', () => {
    expect(deriveStatus('none', null, now)).toBe('open');
  });
});

describe('resolveDueAt — trust a valid model ISO, else fall back to the resolver (§7/§9)', () => {
  const received = '2026-06-01T08:00:00+02:00'; // Mon Jun 1, Prague summer

  it('normalizes a valid model due_at (with offset) to UTC ISO', () => {
    expect(resolveDueAt({ due_at: '2026-06-12T09:30:00+02:00', due_raw: 'noise' }, received)).toBe(
      '2026-06-12T07:30:00.000Z',
    );
  });

  it('falls back to the deterministic resolver when due_at is missing OR unparseable', () => {
    expect(resolveDueAt({ due_at: null, due_raw: 'tomorrow' }, received)).toBe(
      '2026-06-02T21:59:59.000Z',
    );
    // An unparseable due_at must not be trusted — re-resolve due_raw instead of returning garbage.
    expect(resolveDueAt({ due_at: 'not-a-date', due_raw: 'tomorrow' }, received)).toBe(
      '2026-06-02T21:59:59.000Z',
    );
  });

  it('returns null when neither a usable due_at nor a recognizable due_raw is present', () => {
    expect(resolveDueAt({ due_at: null, due_raw: null }, received)).toBeNull();
    expect(resolveDueAt({ due_at: null, due_raw: '   ' }, received)).toBeNull();
    expect(resolveDueAt({ due_at: null, due_raw: 'sometime soon' }, received)).toBeNull();
  });
});

describe('reconcileCandidates — candidate[] → PromiseRecord[] (provenance + confidence floor)', () => {
  const ctx = {
    threadId: 't1' as const,
    messageReceivedIso: '2026-06-01T08:00:00+02:00',
    nowIso: '2026-06-05T12:00:00Z',
  };

  it('stamps each record with a fresh id, the actor, created_at=now, and carries due_raw verbatim', () => {
    const records = reconcileCandidates(
      [candidate({ due_raw: 'by Friday' }), candidate({ text: 'second' })],
      { ...ctx, actor: 'jan', newId },
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.id).not.toBe(records[1]?.id); // distinct ids from the injected factory
    expect(records[0]?.actor).toBe('jan');
    expect(records[0]?.created_at).toBe(ctx.nowIso);
    expect(records[0]?.due_raw).toBe('by Friday'); // raw phrase preserved alongside the resolved due
    expect(records[0]?.due_at).toBe('2026-06-05T21:59:59.000Z');
  });

  it('defaults the actor to the daemon ("claude") when none is supplied', () => {
    const records = reconcileCandidates([candidate()], { ...ctx, newId });
    expect(records[0]?.actor).toBe('claude');
  });

  it('honors the confidence floor: high drops medium+low, default keeps everything', () => {
    const cands = [
      candidate({ confidence: 'high', text: 'h' }),
      candidate({ confidence: 'medium', text: 'm' }),
      candidate({ confidence: 'low', text: 'l' }),
    ];
    expect(
      reconcileCandidates(cands, { ...ctx, newId, minConfidence: 'high' }).map((r) => r.text),
    ).toEqual(['h']);
    expect(reconcileCandidates(cands, { ...ctx, newId }).map((r) => r.text)).toEqual([
      'h',
      'm',
      'l',
    ]);
  });
});

describe('reconcileExisting — flips ONLY open→overdue, never resurrects a terminal (§7)', () => {
  const now = '2026-06-05T00:00:00Z';
  const past = '2026-06-01T00:00:00Z';
  const future = '2026-06-10T00:00:00Z';

  it('open + passed due_at → overdue', () => {
    expect(reconcileExisting([record({ status: 'open', due_at: past })], now)[0]?.status).toBe(
      'overdue',
    );
  });

  it('open is left open for a future due, a null due, or a due exactly == now (strict <)', () => {
    expect(reconcileExisting([record({ status: 'open', due_at: future })], now)[0]?.status).toBe(
      'open',
    );
    expect(reconcileExisting([record({ status: 'open', due_at: null })], now)[0]?.status).toBe(
      'open',
    );
    expect(reconcileExisting([record({ status: 'open', due_at: now })], now)[0]?.status).toBe(
      'open',
    );
  });

  it('NEVER reopens a fulfilled/cancelled record, even with a long-passed due_at', () => {
    expect(reconcileExisting([record({ status: 'fulfilled', due_at: past })], now)[0]?.status).toBe(
      'fulfilled',
    );
    expect(reconcileExisting([record({ status: 'cancelled', due_at: past })], now)[0]?.status).toBe(
      'cancelled',
    );
  });

  it('leaves an already-overdue record overdue (idempotent re-evaluation)', () => {
    expect(reconcileExisting([record({ status: 'overdue', due_at: past })], now)[0]?.status).toBe(
      'overdue',
    );
  });

  it('is PURE: it returns a new array + new object for a flip and never mutates the input', () => {
    const input = record({ status: 'open', due_at: past });
    const inputArray = [input];
    const out = reconcileExisting(inputArray, now);
    expect(out).not.toBe(inputArray);
    expect(out[0]).not.toBe(input); // a flipped record is a fresh object
    expect(input.status).toBe('open'); // the original is untouched
    expect(out[0]?.status).toBe('overdue');
  });
});

describe('groupByDirection — the unified 3-way view (§7)', () => {
  it('routes each record to its column and preserves input order within a column', () => {
    const records: PromiseRecord[] = [
      record({ id: 'a', direction: 'my-promise' }),
      record({ id: 'b', direction: 'awaiting-them' }),
      record({ id: 'c', direction: 'my-promise' }),
      record({ id: 'd', direction: 'they-asked' }),
    ];
    const buckets = groupByDirection(records);
    expect(buckets.myPromises.map((r) => r.id)).toEqual(['a', 'c']);
    expect(buckets.theyAsked.map((r) => r.id)).toEqual(['d']);
    expect(buckets.awaitingThem.map((r) => r.id)).toEqual(['b']);
  });

  it('yields three empty columns for no records', () => {
    const buckets = groupByDirection([]);
    expect(buckets.myPromises).toEqual([]);
    expect(buckets.theyAsked).toEqual([]);
    expect(buckets.awaitingThem).toEqual([]);
  });
});
