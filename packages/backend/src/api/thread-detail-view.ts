/**
 * Assemble the body-free {@link ThreadDetail} for the split work surface LEFT pane (PROJECT.md §11;
 * PLAN.md §7 Phase 7b, D31), and the SEPARATE local-only rendered-body hop.
 *
 * PRIVACY (Golden rule #3): {@link buildThreadDetail} is body-free BY CONSTRUCTION — it surfaces only
 * the sanctioned subject/snippet/sender + message metadata; it never reads a message body. The
 * rendered body is a DISTINCT local hop ({@link renderMessageBody}) that parses the on-disk `.eml`
 * with `mailparser` and is returned ONLY over the localhost API — it is never part of a
 * shared/server-bound DTO and never crosses to the metadata server.
 *
 * Thread → cache mapping: a thread is identified on the server by its `root_message_id`; the cache
 * keys each message's thread by the JWZ `thread_root_id`. We gather a thread's cached messages by
 * matching either, normalized — degrading gracefully (empty `messages`) when the cache has no slice
 * for the thread (e.g. seeded metadata with no synced mail yet).
 */
import { readFile } from 'node:fs/promises';
import { simpleParser } from 'mailparser';
import type {
  Lock,
  RepoFreshness,
  Thread,
  ThreadDetail,
  ThreadMessageMeta,
} from '@mailordomo/shared';
import { SNIPPET_MAX_LENGTH } from '@mailordomo/shared';
import type { MessageCache, MessageRow } from '../cache';
import type { ThreadMessageInput } from '../claude';
import { normalizeMessageId } from '../threading';

/** Cap a snippet at the sanctioned bound so the body-free shape stays identical to the shared one. */
function boundedSnippet(value: string | null): string | null {
  if (value === null) return null;
  return value.length > SNIPPET_MAX_LENGTH ? value.slice(0, SNIPPET_MAX_LENGTH) : value;
}

/** Coerce an empty string to null (e.g. an empty cached sender that would fail `SenderSchema`). */
function nonEmptyOrNull(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

/** The id a message is addressed by in the detail view + the body hop (real id, else a row fallback). */
export function messageKey(row: MessageRow): string {
  return row.message_id ?? `cache-row-${row.id}`;
}

/** Order cache rows oldest → newest (nulls last), tie-broken by row id, for stable rendering. */
function byDateAsc(a: MessageRow, b: MessageRow): number {
  const da = a.internal_date;
  const db = b.internal_date;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  return a.id - b.id;
}

/**
 * Gather a thread's cached messages across all folders, matching on the JWZ `thread_root_id` OR the
 * message's own `message_id` (both normalized to the metadata `root_message_id`). Deduped by message
 * id (a message can appear in several folders, e.g. INBOX + a label), ordered oldest → newest. Uses
 * only the cache's public read methods (it does not touch `cache.ts`).
 */
export function collectThreadRows(cache: MessageCache, rootMessageId: string): MessageRow[] {
  const root = normalizeMessageId(rootMessageId);
  const byKey = new Map<string, MessageRow>();
  for (const folder of cache.allFolders()) {
    for (const row of cache.messagesInFolder(folder.id)) {
      const normSelf = row.message_id ? normalizeMessageId(row.message_id) : null;
      const matches = row.thread_root_id === root || normSelf === root;
      if (!matches) continue;
      const key = messageKey(row);
      // Keep the first occurrence (folders iterate in a stable order).
      if (!byKey.has(key)) byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort(byDateAsc);
}

/** Find a single cached message by its Message-ID (for the body hop). First match wins. */
export function findRowByMessageId(cache: MessageCache, messageId: string): MessageRow | undefined {
  const direct = cache.getMessagesByMessageId(messageId);
  if (direct.length > 0) return direct[0];
  // Fall back to the normalized form (the detail view may surface a normalized id).
  const norm = normalizeMessageId(messageId);
  if (norm !== messageId) {
    const viaNorm = cache.getMessagesByMessageId(norm);
    if (viaNorm.length > 0) return viaNorm[0];
  }
  return undefined;
}

/** Map a cache row to body-free message metadata (the sanctioned fields only). */
export function rowToMessageMeta(row: MessageRow): ThreadMessageMeta {
  return {
    messageId: messageKey(row),
    sender: nonEmptyOrNull(row.sender),
    date: row.internal_date,
    subject: row.subject,
    snippet: boundedSnippet(row.snippet),
  };
}

/** Everything {@link buildThreadDetail} needs — already-gathered + already-fetched, so it stays PURE. */
export interface ThreadDetailInput {
  readonly threadId: string;
  /** The metadata thread (authoritative subject/snippet/sender/lastActivity), or null if unknown. */
  readonly thread: Thread | null;
  /** The thread's cache rows, ordered oldest → newest (from {@link collectThreadRows}). */
  readonly rows: readonly MessageRow[];
  /** Claude's pinned summary (Sonnet), or null when none is available. */
  readonly pinnedSummary: string | null;
  /** Repo-freshness indicator, or null when no repo is linked / not computed (Phase 8). */
  readonly repoFreshness: RepoFreshness | null;
  /** The current lock holder (presence), or null when unlocked. */
  readonly lock: Lock | null;
}

/**
 * PURE: assemble the body-free {@link ThreadDetail}. Thread-level subject/sender/snippet/lastActivity
 * prefer the authoritative metadata thread, falling back to the most-recent cached message when the
 * thread is not (yet) in the metadata service.
 */
export function buildThreadDetail(input: ThreadDetailInput): ThreadDetail {
  const { thread, rows } = input;
  const newest = rows.length > 0 ? rows[rows.length - 1] : undefined;

  return {
    threadId: input.threadId,
    // Resolved best-effort by the GET /api/threads/:id endpoint (D32); the pure builder has no resolver.
    projectName: null,
    subject: thread?.subject ?? newest?.subject ?? null,
    sender: thread?.sender ?? (newest ? nonEmptyOrNull(newest.sender) : null),
    snippet: thread?.snippet ?? (newest ? boundedSnippet(newest.snippet) : null),
    lastActivityAt: thread?.last_message_at ?? newest?.internal_date ?? null,
    messages: rows.map(rowToMessageMeta),
    pinnedSummary: input.pinnedSummary,
    repoFreshness: input.repoFreshness,
    lock: input.lock,
  };
}

/** Strip tags from an HTML body as a crude plain-text fallback when no text/plain part exists. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Parse a message's plain-text body from its on-disk `.eml` (LOCAL ONLY — golden rule #3). Prefers the
 * text/plain part; falls back to a crude HTML strip. Throws if the file is missing/unreadable (the
 * caller maps that to a 404).
 */
export async function renderMessageBody(emlPath: string): Promise<string> {
  const raw = await readFile(emlPath);
  const parsed = await simpleParser(raw);
  if (parsed.text !== undefined && parsed.text.trim() !== '') return parsed.text;
  if (typeof parsed.html === 'string' && parsed.html.trim() !== '') return stripHtml(parsed.html);
  return '';
}

/**
 * Build the {@link ThreadMessageInput}[] (WITH bodies, read locally) that the summarize + draft jobs
 * consume. Rows without an on-disk `.eml` contribute an empty body rather than failing the whole load
 * (best-effort; the model still gets the envelope metadata). Local-only — bodies never leave.
 */
export async function loadThreadMessageInputs(
  rows: readonly MessageRow[],
): Promise<ThreadMessageInput[]> {
  return Promise.all(
    rows.map(async (row): Promise<ThreadMessageInput> => {
      let body = '';
      if (row.eml_path !== null) {
        try {
          body = await renderMessageBody(row.eml_path);
        } catch {
          body = '';
        }
      }
      return {
        sender: row.sender ?? 'unknown sender',
        ...(row.internal_date !== null ? { date: row.internal_date } : {}),
        ...(row.subject !== null ? { subject: row.subject } : {}),
        body,
      };
    }),
  );
}
