/**
 * PURE last-write-wins reconciler for tone-file sync (Golden rule #2 / PROJECT.md §3: the server
 * arbitrates LWW **per file**; there is NEVER a field-level merge between two writable stores). This
 * mirrors the server's arbitration rule (`server/src/repo` tone LWW, PLAN.md D21) on the CLIENT side
 * so the sync orchestrator can decide a direction WITHOUT a redundant round-trip and so the rule is
 * unit-testable in isolation.
 *
 * The rule (identical to the server's, restated from the client's frame):
 *   1. newer `updated_at` wins;
 *   2. on an `updated_at` TIE, the strictly-greater `version_hash` STRING wins;
 *   3. identical (same `updated_at` AND same `version_hash`) ⇒ no-op.
 * A side that is ABSENT loses to a present side (push if only local has it; pull if only server has it);
 * both absent ⇒ no-op.
 *
 * The verdict is whole-FILE: `push` replaces the server's file with the local one, `pull` replaces the
 * local file with the server's — never a merge of fields. PURE: no IO, no clock — `updated_at` is
 * compared as the supplied ISO strings (parsed to an instant); ties fall to the hash string compare.
 */

/** The minimal LWW-relevant metadata of one side of a tone file (local or server). */
export interface LwwSide {
  /** Content/version hash (deterministic hash of the file content — see `tone/store.ts`). */
  readonly version_hash: string;
  /** ISO-8601 instant the file was last written on that side. */
  readonly updated_at: string;
}

/**
 * The reconciliation verdict for one file:
 *  - `push` — the LOCAL side wins; send it to the server (server adopts it).
 *  - `pull` — the SERVER side wins; overwrite the local file with the server's (whole-file).
 *  - `noop` — the two sides are identical (or both absent); nothing to do.
 */
export type LwwDecision = 'push' | 'pull' | 'noop';

/** Parse an ISO instant to epoch-ms; `NaN` for an unparseable string (treated as the oldest). */
function instant(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Decide whether the local tone file should be PUSHED, the server's PULLED, or neither (no-op),
 * mirroring the server's LWW rule. `local`/`server` are the two sides' LWW metadata, or `undefined`
 * when that side has no such file.
 */
export function decideLww(local: LwwSide | undefined, server: LwwSide | undefined): LwwDecision {
  // Absent-side handling: a present file always beats an absent one.
  if (local === undefined && server === undefined) return 'noop';
  if (server === undefined) return 'push';
  if (local === undefined) return 'pull';

  // 1. Newer updated_at wins.
  const localAt = instant(local.updated_at);
  const serverAt = instant(server.updated_at);
  if (localAt > serverAt) return 'push';
  if (serverAt > localAt) return 'pull';

  // 2. updated_at tie → strictly-greater version_hash string wins.
  if (local.version_hash > server.version_hash) return 'push';
  if (server.version_hash > local.version_hash) return 'pull';

  // 3. Identical (same updated_at AND same hash) → no-op.
  return 'noop';
}
