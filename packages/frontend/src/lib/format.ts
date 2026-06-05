/** Date formatting for the do-next cards. Pure + `now`-injectable so it is deterministic in tests. */

const MS_PER_DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A compact, human relative date for a deadline/follow-up: `today` / `tomorrow` / `yesterday`,
 * `in N days` / `N days ago` within a week, else an absolute `12 Jun` (with year if it differs).
 * Returns `''` for an unparseable input. Lowercase to read as a chip (sentence case in context).
 */
export function formatRelativeDate(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.round((startOfDay(then) - startOfDay(now)) / MS_PER_DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days <= 7) return `in ${days} days`;
  if (days < -1 && days >= -7) return `${Math.abs(days)} days ago`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    'en-US',
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
  );
}

/** True when `iso` is strictly in the past relative to `now` (the overdue test for chips). */
export function isPast(iso: string, now: number = Date.now()): boolean {
  const then = Date.parse(iso);
  return !Number.isNaN(then) && then < now;
}

/**
 * Extract a display name from a freeform From header: `Petr <petr@acme.com>` → `Petr`,
 * `"Lumír Novák" <l@x>` → `Lumír Novák`, falling back to the raw/address when there is no name.
 */
export function displaySender(sender: string): string {
  const named = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(sender);
  if (named && named[1] && named[1].trim()) return named[1].trim();
  const bare = /^<?([^<>]+@[^<>]+)>?$/.exec(sender.trim());
  if (bare && bare[1]) return bare[1].trim();
  return sender.trim();
}
