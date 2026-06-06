/**
 * The LIVE daemon message source (PLAN.md D35 — closes the daemon's placeholder seam). It is the
 * concrete {@link DaemonSource} that turns a connected mailbox into the stream of {@link DaemonMessage}s
 * the daemon orchestrator (`runDaemonCycle`) processes: **IMAP poll → cache → enumerate new arrivals**.
 *
 * It REIMPLEMENTS NOTHING: it drives the Phase 3 {@link MailboxSync} (over the resilient IMAP
 * connection's current client), reads back the freshly-synced rows from the disposable
 * {@link MessageCache}, threads them with the existing JWZ engine, and reads bodies LOCALLY from the
 * on-disk `.eml` — exactly the helpers the work surface already uses. Per poll it returns only the
 * messages that are NEW since the last sync cursor, each already upserted as a metadata thread.
 *
 * GOLDEN RULES:
 *  - #3 (bodies never leave): the ONLY thing this module sends across the privacy boundary is
 *    {@link SourceMetadataPort.upsertThread} — the sanctioned subject/snippet/sender. The full body is
 *    read locally into {@link DaemonMessage.body} for the LOCAL `claude` runner; it is never put in a
 *    server-bound DTO. `listTasks` is a read.
 *  - #2 (no two-way sync): writes flow IMAP → cache only (MailboxSync is read-only on IMAP); the
 *    `thread_root_id` written here is a derived LOCAL index, not pushed anywhere.
 *  - #1 (sending is always manual): this module imports nothing under `smtp/**`; it cannot transmit.
 *
 * This is a COMPOSITION module (it bridges imap + cache + threading + metadata), so it lives OUTSIDE
 * `daemon/**` and is INJECTED into the daemon — keeping the orchestrator decoupled from transport and
 * the daemon's structural send-proof reasoning intact (it only ever sees the `DaemonSource` interface).
 */
import type { Task, Thread, UpsertThreadRequest } from '@mailordomo/shared';
import { SNIPPET_MAX_LENGTH } from '@mailordomo/shared';
import type { MessageCache, MessageRow } from '../cache';
import type { DaemonMessage, DaemonSource, DaemonTaskContext } from '../daemon';
import { MailboxSync } from '../imap/mailbox-sync';
import type { ImapClient } from '../imap/types';
import { buildThreads, normalizeMessageId } from '../threading';
import type { ThreadNode } from '../threading';
// Reuse the work surface's body-free thread assembly + the LOCAL-only `.eml` body hop (these are pure
// cache/threading/mailparser helpers — they touch no `smtp`/`api/app`, so the import graph stays clean).
import {
  collectThreadRows,
  loadThreadMessageInputs,
  renderMessageBody,
} from '../api/thread-detail-view';

/** Default number of most-recent messages to triage on a folder's FIRST-EVER sync (see D35). */
export const DEFAULT_INITIAL_BACKLOG = 25;

/** A folder to watch (v1 watches INBOX; the SPECIAL-USE flag is carried through to the cache row). */
export interface SourceFolder {
  readonly path: string;
  readonly specialUse?: string | null;
}

/**
 * The narrow metadata surface the source needs — a structural subset of `MetadataClient`. Deliberately
 * tiny and body-free: it UPSERTS the sanctioned thread fields and READS the thread's tasks. It has no
 * method that could carry a body or transmit mail.
 */
export interface SourceMetadataPort {
  upsertThread(req: UpsertThreadRequest): Promise<Thread>;
  listTasks(threadId?: string): Promise<Task[]>;
}

/** The live IMAP connection seam — the source reads the CURRENT client (null while reconnecting). */
export interface SourceConnection {
  readonly client: ImapClient | null;
}

export interface CacheDaemonSourceDeps {
  /** The resilient IMAP connection (its lifecycle is owned by the daemon loop); read `.client` here. */
  readonly connection: SourceConnection;
  /** The disposable local cache (IMAP truth mirror) the sync writes into and we enumerate from. */
  readonly cache: MessageCache;
  /** The body-free metadata surface (thread upsert + task read). */
  readonly metadata: SourceMetadataPort;
  /** The watched mailbox's address (the cache key + the thread's `mailbox_address`). */
  readonly mailbox: { readonly address: string };
  /** Folders to sync each poll (v1: `[{ path: 'INBOX' }]`). */
  readonly folders: readonly SourceFolder[];
  /** The metadata project id every upserted thread is scoped to. */
  readonly projectId: string;
  /** IANA mailbox timezone for deadline anchoring (defaults to the extractor's Europe/Prague). */
  readonly timezone?: string;
  /** Most-recent N messages to emit on a folder's FIRST sync. Default {@link DEFAULT_INITIAL_BACKLOG}. */
  readonly initialBacklog?: number;
  /** Download raw `.eml` during sync (so bodies are readable). Default true — the daemon needs bodies. */
  readonly downloadSource?: boolean;
  /** Injected clock → ISO "now" (fallback for a message with no internal date). */
  readonly now?: () => string;
  readonly logger?: (message: string, meta?: unknown) => void;
}

/** Walk a JWZ thread tree, invoking `fn` on every node (pre-order). */
function walkTree<M>(node: ThreadNode<M>, fn: (node: ThreadNode<M>) => void): void {
  fn(node);
  for (const child of node.children) walkTree(child, fn);
}

/** True for a real (non-synthetic) `<…>` message-id key produced by the JWZ engine. */
function isRealMessageIdKey(id: string): boolean {
  return id.startsWith('<') && !id.startsWith('<jwz-synthetic');
}

/** A stable, contained synthetic root id for a message that carries NO Message-ID at all. */
function syntheticRootId(row: MessageRow): string {
  return `<mailordomo-cache-${row.folder_id}-${row.uid}@local>`;
}

/**
 * PURE: thread a folder's cache rows and resolve each row's metadata `root_message_id`.
 *
 * The root is, in order of preference: the JWZ tree-root's id when it is a REAL message-id (this both
 * groups own-root messages under themselves AND groups replies under a referenced-but-unfetched
 * original — e.g. a root that lives in Sent); else the earliest real message-id in the tree; else a
 * contained synthetic id derived from (folder, uid). The result always satisfies `MessageIdSchema`
 * (a non-empty string), so it is a safe `upsertThread` key. Exported for the test author.
 */
export function resolveThreadRoots(rows: readonly MessageRow[]): Map<number, string> {
  const items = rows.map((row) => ({
    row,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: row.references_json ? (JSON.parse(row.references_json) as string[]) : null,
    date: row.internal_date,
  }));
  const forest = buildThreads(items);

  const rootByRowId = new Map<number, string>();
  for (const tree of forest) {
    const members: { row: MessageRow; id: string | null; sortKey: number }[] = [];
    walkTree(tree, (node) => {
      const member = node.message;
      if (!member) return;
      members.push({
        row: member.row,
        id: member.row.message_id ? normalizeMessageId(member.row.message_id) : null,
        sortKey: member.row.internal_date
          ? Date.parse(member.row.internal_date)
          : Number.POSITIVE_INFINITY,
      });
    });
    if (members.length === 0) continue;

    const realTreeRoot = isRealMessageIdKey(tree.id) && !tree.synthetic ? tree.id : null;
    const earliestReal = members
      .filter((m) => m.id !== null)
      .sort((a, b) => a.sortKey - b.sortKey)[0]?.id;
    const firstMember = members[0];
    const fallback = firstMember ? syntheticRootId(firstMember.row) : '<mailordomo-empty@local>';
    const rootKey = realTreeRoot ?? earliestReal ?? fallback;

    for (const member of members) rootByRowId.set(member.row.id, rootKey);
  }
  return rootByRowId;
}

/** Collapse whitespace + cap at the sanctioned snippet bound (so the shared shape is preserved). */
function boundedSnippet(value: string | null | undefined): string {
  if (!value) return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > SNIPPET_MAX_LENGTH ? collapsed.slice(0, SNIPPET_MAX_LENGTH) : collapsed;
}

/** Non-empty string, or undefined (an empty cached sender would fail `SenderSchema`'s `min(1)`). */
function nonEmpty(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

/**
 * Map a thread's tasks to the {@link DaemonTaskContext} the engines reason over. The active
 * (first non-`done`) task wins, else the most recent; an empty list ⇒ a brand-new thread (`id: null`,
 * the orchestrator creates the task in the triaged state). `lastActivityIso` drives staleness.
 */
function pickTaskContext(tasks: readonly Task[], lastActivityIso: string): DaemonTaskContext {
  if (tasks.length === 0) {
    return { id: null, state: 'needs-reply', lastActivityIso };
  }
  const active = tasks.find((task) => task.state !== 'done') ?? tasks[tasks.length - 1];
  if (active === undefined) {
    return { id: null, state: 'needs-reply', lastActivityIso };
  }
  return {
    id: active.id,
    state: active.state,
    lastActivityIso,
    followUpAtIso: active.follow_up_at,
    deadlineIso: active.deadline,
  };
}

/**
 * Build the live cache-enumeration {@link DaemonSource}. Each `poll()`:
 *  1. for every watched folder, snapshot the cache cursor, run one {@link MailboxSync} pass over the
 *     connection's current client (read-only on IMAP), and write the JWZ thread roots back to the cache;
 *  2. enumerate the NEW rows — on a folder's first-ever sync the most-recent {@link CacheDaemonSourceDeps.initialBacklog}
 *     (so the Today view is immediately populated without force-triaging years of archive); thereafter
 *     only rows with a UID above the previous cursor;
 *  3. for each, upsert the thread (sanctioned fields only) → read back its task context → read the body
 *     LOCALLY → emit a {@link DaemonMessage}.
 *
 * Resilient: a failure on one folder/message is logged and skipped; the poll never throws. When the
 * connection is down (`client === null`) it returns `[]` — the next poll (interval or IDLE-hot) retries.
 */
export function createCacheDaemonSource(deps: CacheDaemonSourceDeps): DaemonSource {
  const log =
    deps.logger ??
    ((message: string, meta?: unknown) => console.info(`[source] ${message}`, meta ?? ''));
  const nowIso = deps.now ?? ((): string => new Date().toISOString());

  async function buildMessage(
    row: MessageRow,
    rootMessageId: string,
  ): Promise<DaemonMessage | null> {
    const receivedIso = row.internal_date ?? nowIso();

    // Body is read LOCALLY from the on-disk `.eml` (golden rule #3) — it never enters a server DTO.
    let body = '';
    if (row.eml_path !== null) {
      try {
        body = await renderMessageBody(row.eml_path);
      } catch {
        body = '';
      }
    }

    const snippet = boundedSnippet(row.snippet ?? body);
    const sender = nonEmpty(row.sender) ?? 'unknown sender';
    const subject = row.subject ?? '';

    // Cross the privacy boundary with the SANCTIONED fields only (subject/snippet/sender).
    const thread = await deps.metadata.upsertThread({
      project_id: deps.projectId,
      mailbox_address: deps.mailbox.address,
      root_message_id: rootMessageId,
      subject,
      snippet,
      sender,
      last_message_at: receivedIso,
    });

    const tasks = await deps.metadata.listTasks(thread.id);
    const task = pickTaskContext(tasks, thread.last_message_at ?? receivedIso);

    // The whole thread's messages (bodies read locally) for the optional Sonnet summary.
    const threadRows = collectThreadRows(deps.cache, rootMessageId);
    const threadMessages = await loadThreadMessageInputs(threadRows);

    return {
      threadId: thread.id,
      subject,
      sender,
      snippet,
      body,
      receivedIso,
      ...(deps.timezone !== undefined ? { timezone: deps.timezone } : {}),
      task,
      threadMessages,
    };
  }

  async function pollFolder(client: ImapClient, folder: SourceFolder): Promise<DaemonMessage[]> {
    const existing = deps.cache.getFolder(deps.mailbox.address, folder.path);
    const before = existing?.last_seen_uid ?? 0;
    const firstSync = existing === undefined;

    const sync = new MailboxSync(client, deps.cache, {
      mailboxAddress: deps.mailbox.address,
      folderPath: folder.path,
      readOnly: true,
      specialUse: folder.specialUse ?? null,
      downloadSource: deps.downloadSource ?? true,
    });
    await sync.syncOnce();

    const folderRow = deps.cache.getFolder(deps.mailbox.address, folder.path);
    if (folderRow === undefined) return [];

    const allRows = deps.cache.messagesInFolder(folderRow.id); // UID ascending

    // Thread the folder and persist each row's JWZ root into the cache (closes the never-populated
    // `thread_root_id` gap so the summary's thread gather + the 3-pane group correctly). Local index only.
    const roots = resolveThreadRoots(allRows);
    for (const row of allRows) {
      const root = roots.get(row.id);
      if (root !== undefined && row.thread_root_id !== root) deps.cache.setThreadRoot(row.id, root);
    }

    const newRows = firstSync
      ? allRows.slice(-(deps.initialBacklog ?? DEFAULT_INITIAL_BACKLOG))
      : allRows.filter((row) => row.uid > before);

    const messages: DaemonMessage[] = [];
    for (const row of newRows) {
      const rootMessageId = roots.get(row.id) ?? syntheticRootId(row);
      try {
        const message = await buildMessage(row, rootMessageId);
        if (message !== null) messages.push(message);
      } catch (cause) {
        log(`failed to build message uid ${row.uid} in ${folder.path}`, cause);
      }
    }
    return messages;
  }

  return {
    async poll(): Promise<DaemonMessage[]> {
      const client = deps.connection.client;
      if (client === null) {
        log('IMAP not connected; skipping this poll (will retry)');
        return [];
      }
      const out: DaemonMessage[] = [];
      for (const folder of deps.folders) {
        try {
          out.push(...(await pollFolder(client, folder)));
        } catch (cause) {
          log(`poll failed for folder ${folder.path}`, cause);
        }
      }
      return out;
    },
  };
}
