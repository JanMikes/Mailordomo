/**
 * IMAP folder mapper — a PURE engine (no IO).
 *
 * Two responsibilities, both from PROJECT.md §6 ("coarse state mirrored to real IMAP folders"):
 *
 *  1. Map the email-as-task state ↔ a real IMAP folder, BIDIRECTIONALLY, at the COARSE grain the
 *     spec mandates: `active` (not-done) / `waiting` (optional) / `done`. The fine 5-state machine
 *     lives in `state-machine.ts` + the metadata service; only the coarse bucket is mirrored to a
 *     folder so Simona / Mail.app stay consistent without Mailordomo.
 *
 *  2. `resolveSpecialUseFolders` — pick `\Sent \Drafts \Trash \Junk \Archive` (and friends) from a
 *     folder list BY THEIR SPECIAL-USE FLAGS. PROJECT.md §4 is explicit: NEVER hardcode English
 *     folder names ("Sent", "Gesendet", "Odeslané" …); resolve via the RFC 6154 flags only.
 *
 * Purity is deliberate (PLAN.md §2): every function here is a total function of its inputs, so the
 * separate test author can prove both directions and the flag resolution without a live mailbox.
 */
import type { TaskState } from '@mailordomo/shared';

/**
 * Coarse task state mirrored to real IMAP folders (PROJECT.md §6: done / not-done, optionally
 * waiting). This is the lossy projection of the 5-state machine onto the folders a second human
 * sees in a plain mail client.
 */
export const COARSE_TASK_STATES = ['active', 'waiting', 'done'] as const;
export type CoarseTaskState = (typeof COARSE_TASK_STATES)[number];

/**
 * Project a fine {@link TaskState} onto its coarse folder bucket.
 *  - `needs-reply`, `drafted`  → `active`  (work is owed / in progress; lives in the inbox)
 *  - `waiting`, `follow-up`    → `waiting` (the ball is in their court)
 *  - `done`                    → `done`
 */
export function toCoarseState(state: TaskState): CoarseTaskState {
  switch (state) {
    case 'needs-reply':
    case 'drafted':
      return 'active';
    case 'waiting':
    case 'follow-up':
      return 'waiting';
    case 'done':
      return 'done';
  }
}

/**
 * The user's chosen real IMAP folder paths for each coarse bucket. `active` is normally `INBOX`;
 * `waiting` is OPTIONAL (when absent, waiting items simply stay in the `active` folder, per §6's
 * "optionally waiting"). `done` is a real folder (e.g. an "Archive"/"Done" folder) so a closed
 * thread visibly leaves the inbox for everyone.
 */
export interface CoarseFolderMap {
  readonly active: string;
  readonly done: string;
  readonly waiting?: string | undefined;
}

/** INBOX is case-insensitive per RFC 3501; every other folder name is compared exactly. */
function sameFolder(a: string, b: string): boolean {
  if (a.toUpperCase() === 'INBOX' || b.toUpperCase() === 'INBOX') {
    return a.toUpperCase() === b.toUpperCase();
  }
  return a === b;
}

/** Coarse bucket → the real IMAP folder path. `waiting` falls back to `active` when unconfigured. */
export function coarseStateToFolder(state: CoarseTaskState, map: CoarseFolderMap): string {
  switch (state) {
    case 'active':
      return map.active;
    case 'waiting':
      return map.waiting ?? map.active;
    case 'done':
      return map.done;
  }
}

/** Convenience: fine task state → the real IMAP folder it should be mirrored into. */
export function taskStateToFolder(state: TaskState, map: CoarseFolderMap): string {
  return coarseStateToFolder(toCoarseState(state), map);
}

/**
 * Real IMAP folder path → coarse bucket (the reverse direction). `done` is checked first so a
 * misconfiguration where two buckets share a path resolves deterministically to the most
 * consequential one. Returns `undefined` for a folder that is not one of the three mapped folders
 * (e.g. Spam, a personal folder) — the caller decides what an unmapped folder means.
 */
export function folderToCoarseState(
  folder: string,
  map: CoarseFolderMap,
): CoarseTaskState | undefined {
  if (sameFolder(folder, map.done)) return 'done';
  if (map.waiting !== undefined && sameFolder(folder, map.waiting)) return 'waiting';
  if (sameFolder(folder, map.active)) return 'active';
  return undefined;
}

/**
 * The RFC 6154 SPECIAL-USE attributes we resolve. Keys are our internal names; values are the
 * exact IMAP flag tokens a server advertises (case-insensitively) on a LIST response or mailbox.
 * `\Inbox` is imapflow's non-standard convenience flag for INBOX.
 */
export const SPECIAL_USE_FLAGS = {
  all: '\\All',
  archive: '\\Archive',
  drafts: '\\Drafts',
  flagged: '\\Flagged',
  junk: '\\Junk',
  sent: '\\Sent',
  trash: '\\Trash',
  inbox: '\\Inbox',
} as const;
export type SpecialUseKey = keyof typeof SPECIAL_USE_FLAGS;

/** Resolved SPECIAL-USE folder paths, keyed by our internal names. Any key may be absent. */
export type SpecialUseFolders = Partial<Record<SpecialUseKey, string>>;

/**
 * A minimal structural view of an IMAP folder, satisfied by imapflow's `ListResponse` /
 * `MailboxObject` (both carry `path`, an optional `specialUse`, and a `flags` set). Kept structural
 * so this engine never depends on imapflow at the type level.
 */
export interface FolderLike {
  readonly path: string;
  readonly specialUse?: string | undefined;
  readonly flags?: Iterable<string> | undefined;
}

const FLAG_TO_KEY: ReadonlyMap<string, SpecialUseKey> = new Map(
  (Object.entries(SPECIAL_USE_FLAGS) as ReadonlyArray<[SpecialUseKey, string]>).map(
    ([key, flag]) => [flag.toLowerCase(), key] as const,
  ),
);

/**
 * Pick the SPECIAL-USE folders out of a folder list BY FLAG (never by English name). Both the
 * dedicated `specialUse` attribute and the folder's `flags` set are consulted (some servers carry
 * the flag only in one place). First match per key wins, giving a stable, order-deterministic
 * result over the list as provided.
 */
export function resolveSpecialUseFolders(folders: Iterable<FolderLike>): SpecialUseFolders {
  const result: { -readonly [K in SpecialUseKey]?: string } = {};
  for (const folder of folders) {
    const candidates: string[] = [];
    if (folder.specialUse) candidates.push(folder.specialUse);
    if (folder.flags) {
      for (const flag of folder.flags) candidates.push(flag);
    }
    for (const candidate of candidates) {
      const key = FLAG_TO_KEY.get(candidate.toLowerCase());
      if (key && result[key] === undefined) {
        result[key] = folder.path;
      }
    }
  }
  return result;
}
