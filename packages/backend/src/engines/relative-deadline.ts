/**
 * Deterministic relative-deadline resolver — a PURE engine (no IO, no `Date.now()`).
 *
 * PROJECT.md §7 / §9 (decision D-deadline): natural-language deadlines ("by Friday") are resolved by
 * anchoring the relative phrase to the MESSAGE-RECEIVED date in the MAILBOX timezone (Europe/Prague).
 * The LLM extraction step already returns a resolved `due_at`; this is the deterministic FALLBACK the
 * reconciler uses when the model gave a `due_raw` but no usable `due_at` (and a verification seam the
 * test author can pin without the API). It handles the common, unambiguous phrases only — anything it
 * cannot confidently resolve returns `null` (the reconciler then leaves `due_at` unresolved rather
 * than guessing).
 *
 * Europe/Prague is CET (UTC+1) in winter and CEST (UTC+2) in summer. DST in the EU runs from the last
 * Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC. We compute the offset for the
 * RESOLVED LOCAL day deterministically (no `Intl`/tz database dependency, no wall clock) so the result
 * is stable and unit-testable. The resolved instant is the END of the target local day (23:59:59 local)
 * for "by"/day-name phrases — a deadline of "Friday" means "by end of Friday".
 */

/** The mailbox timezone for v1 (PROJECT.md §7/§9). Resolution is anchored to this zone. */
export const MAILBOX_TIMEZONE = 'Europe/Prague' as const;

/** Day-of-week index → name, Sunday = 0 (matches `Date.getUTCDay`). */
const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Maps various spellings/abbreviations to a Sunday=0 index. */
const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A calendar day in the mailbox timezone, as Y/M/D integers (M is 1-12). */
interface LocalDay {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
}

/**
 * The last Sunday of a month (1-12) in a year, as a UTC midnight epoch-ms. EU DST switches at 01:00
 * UTC on the last Sunday of March (→ summer) and October (→ winter).
 */
function lastSundayUtc(year: number, month1to12: number): number {
  // Day 0 of the *next* month is the last day of this month.
  const lastDay = new Date(Date.UTC(year, month1to12, 0));
  const dow = lastDay.getUTCDay(); // 0=Sun
  const lastSundayDate = lastDay.getUTCDate() - dow;
  return Date.UTC(year, month1to12 - 1, lastSundayDate);
}

/**
 * Whether a given UTC instant falls in Europe/Prague summer time (CEST, UTC+2). EU rule: [last Sun
 * Mar 01:00 UTC, last Sun Oct 01:00 UTC). Deterministic; no tz database.
 */
export function isPragueSummer(utcMs: number): boolean {
  const year = new Date(utcMs).getUTCFullYear();
  const dstStart = lastSundayUtc(year, 3) + 1 * 60 * 60 * 1000; // 01:00 UTC last Sun March
  const dstEnd = lastSundayUtc(year, 10) + 1 * 60 * 60 * 1000; // 01:00 UTC last Sun October
  return utcMs >= dstStart && utcMs < dstEnd;
}

/** The Prague UTC offset in minutes for a UTC instant: +120 (CEST) or +60 (CET). */
export function pragueOffsetMinutes(utcMs: number): number {
  return isPragueSummer(utcMs) ? 120 : 60;
}

/**
 * Convert a UTC instant to the Prague LOCAL calendar day (Y/M/D + weekday). We add the offset for the
 * instant, then read the shifted clock's UTC fields — those are the Prague wall-clock fields.
 */
function toLocalDay(utcMs: number): { day: LocalDay; weekday: number } {
  const shifted = new Date(utcMs + pragueOffsetMinutes(utcMs) * 60 * 1000);
  return {
    day: {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    },
    weekday: shifted.getUTCDay(),
  };
}

/**
 * Build the UTC instant for a Prague-LOCAL day at a given local time-of-day. The offset depends on the
 * resulting instant (DST), so we estimate the offset from a provisional UTC, then refine once — a
 * second pass is enough because a single day is never split across a DST boundary except in the switch
 * hour, which `endOfDay` (23:59:59) never lands in.
 */
function localDayToUtc(day: LocalDay, hour: number, minute: number, second: number): number {
  const naive = Date.UTC(day.year, day.month - 1, day.day, hour, minute, second);
  const provisionalOffset = pragueOffsetMinutes(naive);
  const firstPass = naive - provisionalOffset * 60 * 1000;
  const refinedOffset = pragueOffsetMinutes(firstPass);
  return naive - refinedOffset * 60 * 1000;
}

/** Add `n` whole days to a Prague-local day, normalizing month/year via UTC date arithmetic. */
function addLocalDays(day: LocalDay, n: number): LocalDay {
  const base = Date.UTC(day.year, day.month - 1, day.day) + n * MS_PER_DAY;
  const d = new Date(base);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Days forward from `fromWeekday` to the next occurrence of `targetWeekday` (1-7; never 0/today). */
function daysUntilNextWeekday(fromWeekday: number, targetWeekday: number): number {
  const diff = (targetWeekday - fromWeekday + 7) % 7;
  return diff === 0 ? 7 : diff;
}

/** End-of-day local wall time used for date-granularity deadlines ("by Friday" ⇒ end of Friday). */
const END_OF_DAY = { hour: 23, minute: 59, second: 59 } as const;

/**
 * Resolve a relative/absolute deadline phrase to an absolute UTC `Date`, anchored to `anchorIso` (the
 * message-received instant) interpreted in Europe/Prague. Returns `null` when the phrase is empty or
 * not confidently recognized (the caller then leaves the deadline unresolved). Pure: depends only on
 * its arguments.
 *
 * Recognized (case-insensitive, tolerant of "by "/"due "/"end of " prefixes and punctuation):
 *  - `today`, `tomorrow`, `yesterday`
 *  - `eod` / `end of day` (today), `eow` / `end of (the/this) week` (this Friday)
 *  - a weekday name (`friday`, `mon`, …) → the NEXT such weekday strictly after the anchor day;
 *    `next <weekday>` → the weekday in the following week
 *  - `next week` (the following Friday), `next month` (same day-of-month next month)
 *  - `in N day(s)/week(s)` and `N day(s) from now`
 *  - an ISO-8601 date (`2026-06-12`) or datetime (passed through, anchoring not needed)
 */
export function resolveRelativeDeadline(raw: string, anchorIso: string): Date | null {
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return null;

  const cleaned = raw.trim().toLowerCase();
  if (cleaned === '') return null;

  // A fully-qualified ISO datetime: trust it as-is (no anchoring needed).
  const isoDateTime = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i;
  if (isoDateTime.test(raw.trim())) {
    const ms = Date.parse(raw.trim());
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  // A bare ISO date: end of that local day.
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (isoDate) {
    const [, y, m, d] = isoDate;
    const day: LocalDay = { year: Number(y), month: Number(m), day: Number(d) };
    return new Date(localDayToUtc(day, END_OF_DAY.hour, END_OF_DAY.minute, END_OF_DAY.second));
  }

  const { day: anchorDay, weekday: anchorWeekday } = toLocalDay(anchorMs);

  // Strip leading filler so "by Friday" / "due end of week" / "by next monday" all match.
  const phrase = cleaned.replace(/^(by|due|due by|before|on|until|till|til)\s+/u, '').trim();

  const atEndOfDay = (day: LocalDay): Date =>
    new Date(localDayToUtc(day, END_OF_DAY.hour, END_OF_DAY.minute, END_OF_DAY.second));

  // today / tomorrow / yesterday
  if (phrase === 'today' || phrase === 'end of day' || phrase === 'eod' || phrase === 'cob') {
    return atEndOfDay(anchorDay);
  }
  if (phrase === 'tomorrow') {
    return atEndOfDay(addLocalDays(anchorDay, 1));
  }
  if (phrase === 'yesterday') {
    return atEndOfDay(addLocalDays(anchorDay, -1));
  }

  // end of week / this week → this Friday (weekday 5)
  if (
    phrase === 'eow' ||
    phrase === 'end of week' ||
    phrase === 'end of the week' ||
    phrase === 'end of this week' ||
    phrase === 'this week'
  ) {
    const delta = (5 - anchorWeekday + 7) % 7; // Friday this week (0 if anchor IS Friday)
    return atEndOfDay(addLocalDays(anchorDay, delta));
  }

  // next week → the FOLLOWING week's Friday
  if (phrase === 'next week' || phrase === 'end of next week') {
    const deltaToThisFriday = (5 - anchorWeekday + 7) % 7;
    return atEndOfDay(addLocalDays(anchorDay, deltaToThisFriday + 7));
  }

  // next month → same day-of-month, one month on (clamped by Date arithmetic)
  if (phrase === 'next month') {
    const next: LocalDay = { year: anchorDay.year, month: anchorDay.month + 1, day: anchorDay.day };
    // Normalize via UTC (handles year rollover + clamps overflow days).
    const norm = new Date(Date.UTC(next.year, next.month - 1, next.day));
    return atEndOfDay({
      year: norm.getUTCFullYear(),
      month: norm.getUTCMonth() + 1,
      day: norm.getUTCDate(),
    });
  }

  // "in N days/weeks" or "N day(s) from now"
  const inN = /^(?:in\s+)?(\d{1,3})\s+(day|days|week|weeks)(?:\s+from\s+now)?$/u.exec(phrase);
  if (inN && inN[1] !== undefined && inN[2] !== undefined) {
    const n = Number(inN[1]);
    const unitDays = inN[2].startsWith('week') ? 7 : 1;
    return atEndOfDay(addLocalDays(anchorDay, n * unitDays));
  }

  // "next <weekday>" → that weekday in the week AFTER the anchor's week. `daysUntilNextWeekday`
  // returns 1..7 (the next strict occurrence). When that occurrence is still in the current week
  // (d < 7) we push it a week on; when it is already 7 days out (the anchor IS that weekday) it is
  // already next week's occurrence, so we DON'T double-count. → "next Mon" from a Mon = +7 (not +14).
  const nextWeekday = /^next\s+([a-z]+)$/u.exec(phrase);
  if (nextWeekday && nextWeekday[1] !== undefined) {
    const target = WEEKDAY_INDEX[nextWeekday[1]];
    if (target !== undefined) {
      const occurrence = daysUntilNextWeekday(anchorWeekday, target); // 1..7
      const delta = occurrence < 7 ? occurrence + 7 : occurrence;
      return atEndOfDay(addLocalDays(anchorDay, delta));
    }
  }

  // a bare weekday name → the NEXT such weekday strictly after the anchor day
  const bareWeekday = WEEKDAY_INDEX[phrase];
  if (bareWeekday !== undefined) {
    return atEndOfDay(addLocalDays(anchorDay, daysUntilNextWeekday(anchorWeekday, bareWeekday)));
  }

  return null;
}

/** Exposed for tests/diagnostics: the canonical weekday name for a Sunday=0 index. */
export function weekdayName(index: number): (typeof WEEKDAY_NAMES)[number] | undefined {
  return WEEKDAY_NAMES[index];
}
