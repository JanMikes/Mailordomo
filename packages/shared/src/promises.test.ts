/**
 * The 3-way promise tracker, asserted against PROJECT.md §7 (directions, status lifecycle, and
 * deadline anchoring) — derived from intent, not the schema.
 *
 * §7: three directions (my promises / they asked / awaiting them); status `open → fulfilled |
 * overdue | cancelled`; natural-language deadlines ("by Friday") are resolved by anchoring the
 * LLM's relative date to the message date — so a record must carry BOTH the resolved absolute
 * `due_at` AND the raw relative deadline, kept separable for the extraction/reconciliation split.
 */
import { describe, expect, it } from 'vitest';
import {
  CreatePromiseRequestSchema,
  PROMISE_DIRECTIONS,
  PROMISE_STATUSES,
  PromiseDirectionSchema,
  PromiseSchema,
  PromiseStatusSchema,
} from './index';

describe('promise directions (§7 — exactly three)', () => {
  it('are exactly my-promise / they-asked / awaiting-them', () => {
    expect([...PROMISE_DIRECTIONS]).toEqual(['my-promise', 'they-asked', 'awaiting-them']);
  });

  it('accepts each direction and rejects anything else', () => {
    for (const dir of PROMISE_DIRECTIONS) {
      expect(() => PromiseDirectionSchema.parse(dir)).not.toThrow();
    }
    expect(() => PromiseDirectionSchema.parse('mine')).toThrow();
  });
});

describe('promise status lifecycle (§7 — open → fulfilled | overdue | cancelled)', () => {
  it('are exactly the four lifecycle states', () => {
    expect([...PROMISE_STATUSES]).toEqual(['open', 'fulfilled', 'overdue', 'cancelled']);
  });

  it('includes open as the starting status and the three resolutions', () => {
    expect(PROMISE_STATUSES).toContain('open');
    expect(PROMISE_STATUSES).toContain('fulfilled');
    expect(PROMISE_STATUSES).toContain('overdue');
    expect(PROMISE_STATUSES).toContain('cancelled');
  });

  it('accepts each status and rejects anything else', () => {
    for (const status of PROMISE_STATUSES) {
      expect(() => PromiseStatusSchema.parse(status)).not.toThrow();
    }
    expect(() => PromiseStatusSchema.parse('pending')).toThrow();
  });
});

describe('deadline anchoring (§7) — a record carries both resolved and raw deadlines', () => {
  const base = {
    id: 'pr1',
    thread_id: 'th1',
    direction: 'awaiting-them' as const,
    text: 'They will reply with the figures',
    status: 'open' as const,
    actor: 'jan',
    created_at: '2026-06-05T09:15:23Z',
  };

  it('round-trips with a resolved due_at AND a raw relative deadline', () => {
    const record = { ...base, due_at: '2026-06-12T16:00:00Z', due_raw: 'by Friday' };
    expect(PromiseSchema.parse(record)).toEqual(record);
  });

  it('allows an extracted-but-unresolved deadline (due_raw set, due_at still null)', () => {
    const record = { ...base, due_at: null, due_raw: 'sometime next week' };
    expect(() => PromiseSchema.parse(record)).not.toThrow();
  });

  it('allows no deadline at all (both null)', () => {
    const record = { ...base, due_at: null, due_raw: null };
    expect(() => PromiseSchema.parse(record)).not.toThrow();
  });

  it('exposes due_at and due_raw as distinct fields (extraction/reconciliation split)', () => {
    const keys = Object.keys(PromiseSchema.shape);
    expect(keys).toContain('due_at');
    expect(keys).toContain('due_raw');
  });
});

describe('promise defaults / optionality (§7 intent)', () => {
  it('stored Promise requires a status (a stored promise is always in the lifecycle)', () => {
    const withoutStatus = {
      id: 'pr1',
      thread_id: 'th1',
      direction: 'my-promise',
      text: 'Deliver the deck',
      due_at: null,
      due_raw: null,
      actor: 'jan',
      created_at: '2026-06-05T09:15:23Z',
    };
    expect(() => PromiseSchema.parse(withoutStatus)).toThrow();
  });

  it('CreatePromiseRequest may omit status, due_at and due_raw (server defaults; not yet resolved)', () => {
    expect(() =>
      CreatePromiseRequestSchema.parse({
        thread_id: 'th1',
        direction: 'they-asked',
        text: 'Please send the invoice',
        actor: 'jan',
      }),
    ).not.toThrow();
  });

  it('CreatePromiseRequest still requires direction, text and actor', () => {
    expect(() =>
      CreatePromiseRequestSchema.parse({ thread_id: 'th1', text: 'x', actor: 'jan' }),
    ).toThrow();
    expect(() =>
      CreatePromiseRequestSchema.parse({ thread_id: 'th1', direction: 'my-promise', actor: 'jan' }),
    ).toThrow();
  });
});
