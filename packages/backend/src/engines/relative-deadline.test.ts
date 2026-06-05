/**
 * INTENT-DERIVED + ADVERSARIAL suite for the deterministic relative-deadline resolver
 * (PROJECT.md §7/§9): natural-language deadlines anchored to the message-received instant in
 * Europe/Prague, resolved to the END of the target local day. Complements `relative-deadline.smoke
 * .test.ts`.
 *
 * ALL expected instants are computed from FIRST PRINCIPLES (the real EU rule), NOT read off the impl:
 *  - CEST = UTC+2 (summer) ⇒ end-of-day 23:59:59 local = 21:59:59Z.
 *  - CET  = UTC+1 (winter) ⇒ end-of-day 23:59:59 local = 22:59:59Z.
 *  - 2026 spring-forward: Sun 29 Mar, 01:00 UTC (CET→CEST). Fall-back: Sun 25 Oct, 01:00 UTC.
 *  - 1 Jun 2026 is a Monday.
 * The headline adversarial cases are deadlines whose resolved day sits on the OPPOSITE side of a DST
 * switch from the anchor day.
 */
import { describe, expect, it } from 'vitest';
import { isPragueSummer, pragueOffsetMinutes, resolveRelativeDeadline } from './relative-deadline';

/** Resolve and return the UTC ISO string (or null) — every expectation is an exact UTC instant. */
const iso = (raw: string, anchor: string): string | null =>
  resolveRelativeDeadline(raw, anchor)?.toISOString() ?? null;

describe('Prague offset — DST boundary facts derived from the EU rule', () => {
  it('flips offset exactly at the spring-forward instant (29 Mar 2026, 01:00 UTC)', () => {
    expect(pragueOffsetMinutes(Date.parse('2026-03-29T00:59:59.999Z'))).toBe(60); // still CET
    expect(pragueOffsetMinutes(Date.parse('2026-03-29T01:00:00.000Z'))).toBe(120); // now CEST
  });
  it('flips offset exactly at the fall-back instant (25 Oct 2026, 01:00 UTC)', () => {
    expect(pragueOffsetMinutes(Date.parse('2026-10-25T00:59:59.999Z'))).toBe(120); // still CEST
    expect(pragueOffsetMinutes(Date.parse('2026-10-25T01:00:00.000Z'))).toBe(60); // now CET
  });
  it('treats the whole winter period (incl. across the new year) as CET', () => {
    expect(isPragueSummer(Date.parse('2025-12-31T23:59:59Z'))).toBe(false);
    expect(isPragueSummer(Date.parse('2026-01-01T00:00:00Z'))).toBe(false);
    expect(isPragueSummer(Date.parse('2026-07-15T12:00:00Z'))).toBe(true);
  });
});

describe('resolveRelativeDeadline — anchored to the message day (Prague summer)', () => {
  const monday = '2026-06-01T08:00:00+02:00'; // Mon 1 Jun 2026, CEST

  it.each([
    ['today', '2026-06-01T21:59:59.000Z'],
    ['eod', '2026-06-01T21:59:59.000Z'],
    ['end of day', '2026-06-01T21:59:59.000Z'],
    ['tomorrow', '2026-06-02T21:59:59.000Z'],
    ['yesterday', '2026-05-31T21:59:59.000Z'],
    ['in 3 days', '2026-06-04T21:59:59.000Z'],
    ['in 1 week', '2026-06-08T21:59:59.000Z'],
    ['5 days from now', '2026-06-06T21:59:59.000Z'],
    ['eow', '2026-06-05T21:59:59.000Z'],
    ['next week', '2026-06-12T21:59:59.000Z'],
  ])('%j → %s', (raw, expected) => {
    expect(iso(raw, monday)).toBe(expected);
  });

  it('tolerates "by/due/before/until" filler before the phrase', () => {
    expect(iso('by Friday', monday)).toBe('2026-06-05T21:59:59.000Z');
    expect(iso('due Wednesday', monday)).toBe('2026-06-03T21:59:59.000Z');
    expect(iso('before next monday', monday)).toBe('2026-06-08T21:59:59.000Z');
  });
});

describe('weekday phrases — bare = next strict occurrence; "next" = the following week', () => {
  const monday = '2026-06-01T08:00:00+02:00'; // Mon 1 Jun 2026

  it('a bare weekday is the NEXT such day strictly after the anchor', () => {
    expect(iso('Wednesday', monday)).toBe('2026-06-03T21:59:59.000Z'); // Wed 3 Jun
    expect(iso('Friday', monday)).toBe('2026-06-05T21:59:59.000Z'); // Fri 5 Jun
  });

  it('a bare weekday equal to the anchor weekday rolls a full week (never "today")', () => {
    expect(iso('Monday', monday)).toBe('2026-06-08T21:59:59.000Z'); // +7, not Jun 1
  });

  it('"next <weekday>" lands in the following week — and from the SAME weekday is +7, NOT +14', () => {
    expect(iso('next Monday', monday)).toBe('2026-06-08T21:59:59.000Z'); // the +7-not-+14 guard
    expect(iso('next Tuesday', monday)).toBe('2026-06-09T21:59:59.000Z');
    expect(iso('next Friday', monday)).toBe('2026-06-12T21:59:59.000Z'); // following week's Friday
  });
});

describe('ADVERSARIAL — deadlines that cross a DST switch relative to the anchor', () => {
  it('end-of-day on the spring-forward day: CET-morning anchor → CEST evening (21:59:59Z)', () => {
    // Anchor 00:30Z on 29 Mar is still CET (before the 01:00Z switch); end of 29 Mar is CEST.
    expect(iso('eod', '2026-03-29T00:30:00Z')).toBe('2026-03-29T21:59:59.000Z');
  });

  it('end-of-day on the fall-back day: CEST-morning anchor → CET evening (22:59:59Z)', () => {
    // Anchor 00:30Z on 25 Oct is still CEST (before the 01:00Z switch); end of 25 Oct is CET.
    expect(iso('eod', '2026-10-25T00:30:00Z')).toBe('2026-10-25T22:59:59.000Z');
  });

  it('a winter anchor whose deadline falls in summer uses the SUMMER offset (21:59:59Z)', () => {
    // Fri 27 Mar (CET) + 5 days = Wed 1 Apr (CEST).
    expect(iso('in 5 days', '2026-03-27T08:00:00+01:00')).toBe('2026-04-01T21:59:59.000Z');
  });

  it('a summer anchor whose deadline falls in winter uses the WINTER offset (22:59:59Z)', () => {
    // Fri 23 Oct (CEST) + 5 days = Wed 28 Oct (CET).
    expect(iso('in 5 days', '2026-10-23T08:00:00+02:00')).toBe('2026-10-28T22:59:59.000Z');
  });

  it('plain end-of-day differs by season: summer 21:59:59Z vs winter 22:59:59Z', () => {
    expect(iso('today', '2026-07-15T10:00:00Z')).toBe('2026-07-15T21:59:59.000Z');
    expect(iso('today', '2026-12-15T10:00:00Z')).toBe('2026-12-15T22:59:59.000Z');
  });
});

describe('ISO inputs', () => {
  const monday = '2026-06-01T08:00:00+02:00';

  it('a bare ISO date resolves to the end of that local day (season-correct)', () => {
    expect(iso('2026-06-12', monday)).toBe('2026-06-12T21:59:59.000Z'); // summer
    expect(iso('2026-12-25', monday)).toBe('2026-12-25T22:59:59.000Z'); // winter
  });

  it('a fully-qualified ISO datetime passes through to its exact instant (no re-anchoring)', () => {
    expect(iso('2026-06-12T09:30:00Z', monday)).toBe('2026-06-12T09:30:00.000Z');
    expect(iso('2026-06-12T09:30:00+02:00', monday)).toBe('2026-06-12T07:30:00.000Z');
  });
});

describe('unrecognized input → null (the resolver never guesses)', () => {
  const monday = '2026-06-01T08:00:00+02:00';

  it.each(['', '   ', 'asap', 'whenever', 'next quarter', 'in a bit', 'someday', 'when you can'])(
    '%j → null',
    (raw) => {
      expect(resolveRelativeDeadline(raw, monday)).toBeNull();
    },
  );

  it('returns null on an unparseable anchor (cannot anchor ⇒ cannot resolve)', () => {
    expect(resolveRelativeDeadline('tomorrow', 'not-a-date')).toBeNull();
  });
});
