/**
 * Time helpers. All datetimes the service generates are ISO-8601 in UTC (`Z` form) so stored
 * strings sort lexicographically by instant — see `repo/sqlite.ts` `normalizeIso`.
 */

/** Current instant as an ISO-8601 UTC string (e.g. `2026-06-05T10:11:12.000Z`). */
export function nowIso(): string {
  return new Date().toISOString();
}
