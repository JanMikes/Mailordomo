/**
 * SMOKE — the deterministic relative-deadline resolver (PROJECT.md §7/§9). Thin coverage; the
 * SEPARATE test-author writes the exhaustive anchoring/DST suite. Here we pin the load-bearing
 * behaviors: anchoring to the message day in Europe/Prague, end-of-day semantics, the CET/CEST
 * boundary, and graceful null on unrecognized input.
 */
import { describe, expect, it } from 'vitest';
import { isPragueSummer, pragueOffsetMinutes, resolveRelativeDeadline } from './relative-deadline';

describe('Prague DST offset', () => {
  it('is +120 (CEST) in summer and +60 (CET) in winter', () => {
    expect(pragueOffsetMinutes(Date.parse('2026-07-01T00:00:00Z'))).toBe(120);
    expect(pragueOffsetMinutes(Date.parse('2026-01-01T00:00:00Z'))).toBe(60);
  });
  it('switches at the last Sunday of March/October (01:00 UTC)', () => {
    // 2026: last Sun March = Mar 29; last Sun Oct = Oct 25.
    expect(isPragueSummer(Date.parse('2026-03-29T00:59:00Z'))).toBe(false);
    expect(isPragueSummer(Date.parse('2026-03-29T01:00:00Z'))).toBe(true);
    expect(isPragueSummer(Date.parse('2026-10-25T00:59:00Z'))).toBe(true);
    expect(isPragueSummer(Date.parse('2026-10-25T01:00:00Z'))).toBe(false);
  });
});

describe('resolveRelativeDeadline — anchored to the message day in Prague', () => {
  const monday = '2026-06-01T08:00:00+02:00'; // Mon Jun 1, Prague CEST

  it('"by Friday" → end of the first Friday on/after the anchor (Fri Jun 5, 21:59:59Z in CEST)', () => {
    expect(resolveRelativeDeadline('by Friday', monday)?.toISOString()).toBe(
      '2026-06-05T21:59:59.000Z',
    );
  });
  it('"tomorrow" → end of the next local day', () => {
    expect(resolveRelativeDeadline('tomorrow', monday)?.toISOString()).toBe(
      '2026-06-02T21:59:59.000Z',
    );
  });
  it('"in 3 days" → end of anchor + 3 days', () => {
    expect(resolveRelativeDeadline('in 3 days', monday)?.toISOString()).toBe(
      '2026-06-04T21:59:59.000Z',
    );
  });
  it('"next Monday" → the Monday in the following week (Jun 8)', () => {
    expect(resolveRelativeDeadline('next Monday', monday)?.toISOString()).toBe(
      '2026-06-08T21:59:59.000Z',
    );
  });
  it('a bare weekday equal to the anchor day rolls to next week (Mon → Jun 8)', () => {
    expect(resolveRelativeDeadline('Monday', monday)?.toISOString()).toBe(
      '2026-06-08T21:59:59.000Z',
    );
  });
  it('a winter anchor uses CET (+01:00) → end of day is 22:59:59Z', () => {
    const janMon = '2026-01-05T08:00:00+01:00'; // Mon Jan 5, Prague CET
    expect(resolveRelativeDeadline('tomorrow', janMon)?.toISOString()).toBe(
      '2026-01-06T22:59:59.000Z',
    );
  });
  it('a bare ISO date resolves to end of that local day', () => {
    expect(resolveRelativeDeadline('2026-06-12', monday)?.toISOString()).toBe(
      '2026-06-12T21:59:59.000Z',
    );
  });
  it('an ISO datetime passes through as-is', () => {
    expect(resolveRelativeDeadline('2026-06-12T09:30:00Z', monday)?.toISOString()).toBe(
      '2026-06-12T09:30:00.000Z',
    );
  });
  it('returns null on empty / unrecognized phrasing and a bad anchor', () => {
    expect(resolveRelativeDeadline('', monday)).toBeNull();
    expect(resolveRelativeDeadline('soonish', monday)).toBeNull();
    expect(resolveRelativeDeadline('by Friday', 'not-a-date')).toBeNull();
  });
});
