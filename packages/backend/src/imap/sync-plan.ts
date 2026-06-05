/**
 * Sync-delta computation — PURE (no client, no IO). This is the load-bearing decision the test
 * author exercises with fixtures (local cursor × server state → expected plan), with NO live
 * mailbox. The engine in `mailbox-sync.ts` only *executes* the plan this function returns.
 *
 * The rules (PROJECT.md §4):
 *  - No local state, or a changed `uidValidity` ⇒ FULL RESYNC (invalidate that folder, refetch
 *    everything). uidValidity changing is the IMAP server's way of saying "your UIDs are void".
 *  - Otherwise INCREMENTAL: fetch UIDs above the last-seen one, and — when CONDSTORE/QRESYNC gives
 *    a higher modseq — re-fetch flag/state deltas `changedSince` the last known modseq.
 *  - Nothing new and no modseq movement ⇒ UP TO DATE.
 */

/** The cache's view of a folder before this sync pass. */
export interface LocalFolderState {
  /** `null`/`undefined` ⇒ never synced. */
  readonly uidValidity?: string | null;
  /** Highest UID already cached; `0` ⇒ none. */
  readonly lastSeenUid: number;
  /** Highest modseq already synced (decimal string), if CONDSTORE was available. */
  readonly highestModseq?: string | null;
}

/** The server's freshly-opened mailbox state. */
export interface ServerFolderState {
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly highestModseq?: string | null;
}

export type SyncPlan =
  | {
      readonly kind: 'full-resync';
      readonly reason: 'no-local-state' | 'uidvalidity-changed';
      readonly fetchRange: string;
      readonly serverUidValidity: string;
    }
  | {
      readonly kind: 'incremental';
      /** UID range of brand-new messages to fetch, or `null` when there are none. */
      readonly fetchNewRange: string | null;
      /** Modseq to pass as CONDSTORE `changedSince` for flag deltas, or `null` when not applicable. */
      readonly changedSince: string | null;
    }
  | { readonly kind: 'up-to-date' };

/** Compute the sync plan for one folder. Total function of its two inputs. */
export function computeSyncPlan(local: LocalFolderState, server: ServerFolderState): SyncPlan {
  if (local.uidValidity == null || local.lastSeenUid <= 0) {
    return {
      kind: 'full-resync',
      reason: 'no-local-state',
      fetchRange: '1:*',
      serverUidValidity: server.uidValidity,
    };
  }

  if (local.uidValidity !== server.uidValidity) {
    return {
      kind: 'full-resync',
      reason: 'uidvalidity-changed',
      fetchRange: '1:*',
      serverUidValidity: server.uidValidity,
    };
  }

  // New messages exist iff the next-to-be-assigned UID is beyond (last seen + 1).
  const hasNew = server.uidNext > local.lastSeenUid + 1;
  const fetchNewRange = hasNew ? `${local.lastSeenUid + 1}:*` : null;

  const modseqMoved =
    local.highestModseq != null &&
    server.highestModseq != null &&
    server.highestModseq !== local.highestModseq;
  const changedSince = modseqMoved ? local.highestModseq! : null;

  if (fetchNewRange === null && changedSince === null) {
    return { kind: 'up-to-date' };
  }
  return { kind: 'incremental', fetchNewRange, changedSince };
}
