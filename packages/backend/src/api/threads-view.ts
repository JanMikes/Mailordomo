/**
 * Assemble a minimal THREAD list for `GET /api/threads` from the disposable {@link MessageCache},
 * using only its existing public read methods (this module does not touch `cache.ts`).
 *
 * PRIVACY (Golden rule #3): this is the localhost backend → localhost frontend hop, but we still
 * surface METADATA ONLY — subject / snippet / sender / flags / dates. We deliberately do NOT read or
 * return any message body, even though it never leaves the machine here, to keep the shape identical
 * to what may later be shared and to avoid bodies in the frontend payload by habit.
 *
 * "Threads" are derived by grouping cached messages on `thread_root_id` (the JWZ root assigned in
 * Phase 3), falling back to the message's own `message_id`, then to a synthetic per-row key. Task
 * STATE is the metadata service's truth, not the cache's — so it is intentionally absent here; this
 * endpoint exists to prove the cache surfaces real data to the UI, not to render the task board.
 */
import type { MessageCache, MessageRow } from '../cache';

/** One row in the minimal thread list the frontend renders. METADATA ONLY — no body. */
export interface ThreadListItem {
  /** Grouping key: the JWZ thread root id, else the message id, else a synthetic key. */
  readonly threadKey: string;
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly sender: string | null;
  /** ISO timestamp of the most recent message in the group (max `internal_date`). */
  readonly lastMessageAt: string | null;
  /** How many cached messages fall under this thread key. */
  readonly messageCount: number;
}

function groupKey(row: MessageRow): string {
  return row.thread_root_id ?? row.message_id ?? `row:${row.id}`;
}

/** Pick the more recent of two nullable ISO timestamps (nulls sort earliest). */
function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Build the thread list across every cached folder. One representative (the most recent message)
 * supplies each thread's subject/snippet/sender. Sorted most-recent-first. `limit` caps the result.
 */
export function listCachedThreads(cache: MessageCache, limit = 200): ThreadListItem[] {
  const byKey = new Map<string, ThreadListItem>();

  for (const folder of cache.allFolders()) {
    for (const row of cache.messagesInFolder(folder.id)) {
      const key = groupKey(row);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          threadKey: key,
          subject: row.subject,
          snippet: row.snippet,
          sender: row.sender,
          lastMessageAt: row.internal_date,
          messageCount: 1,
        });
        continue;
      }
      // Keep the representative envelope from the most recent message in the group.
      const isNewer =
        existing.lastMessageAt === null ||
        (row.internal_date !== null && row.internal_date > existing.lastMessageAt);
      byKey.set(key, {
        threadKey: key,
        subject: isNewer ? row.subject : existing.subject,
        snippet: isNewer ? row.snippet : existing.snippet,
        sender: isNewer ? row.sender : existing.sender,
        lastMessageAt: laterIso(existing.lastMessageAt, row.internal_date),
        messageCount: existing.messageCount + 1,
      });
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => {
      // Most-recent-first; nulls last.
      if (a.lastMessageAt === b.lastMessageAt) return 0;
      if (a.lastMessageAt === null) return 1;
      if (b.lastMessageAt === null) return -1;
      return a.lastMessageAt > b.lastMessageAt ? -1 : 1;
    })
    .slice(0, limit);
}
