/**
 * INTENT-DERIVED coverage for the LIVE daemon message source (PLAN.md D35 — the seam that closes the
 * daemon's placeholder: **IMAP poll → cache → enumerate new arrivals**). Authored by a SEPARATE
 * test-author from the implementer; assertions are derived from PROJECT.md §2/§3/§5/§6 intent FIRST,
 * then checked against the implementation. This file goes BROADER than the implementer's
 * `cache-source.smoke.test.ts` (it does not duplicate it).
 *
 * DISCIPLINE (per the §4.4 protocol):
 *  - FAKES + the REAL in-process metadata server (`startInProcessServer`) + a REAL in-memory
 *    {@link MessageCache} with an on-disk tmp blob dir (so `.eml` bodies are stored/readable).
 *  - NO live IMAP, NO live `claude`, NO network. Fully deterministic.
 *
 * The invariants under test (the WHAT, derived from the spec):
 *  1. poll→cache→enumerate end-to-end: a fake IMAP message becomes a {@link DaemonMessage} carrying
 *     the metadata `threadId`, the sanctioned subject/snippet/sender, and the body read LOCALLY (§3/§5).
 *  2. Idempotency: re-polling with no new mail emits nothing; a later arrival emits ONLY the new one —
 *     the daemon never reprocesses (which would re-triage / double-promise) (§6 poll loop).
 *  3. Golden rule #3: the FULL body NEVER crosses to the server — only the sanctioned fields +
 *     a snippet bounded at {@link SNIPPET_MAX_LENGTH} (the §5 exception). Proven with a marker placed
 *     AFTER the bound, scanned in every outbound request via `capturingFetch`.
 *  4. Threading: a reply groups under the SAME `root_message_id` as the original ⇒ ONE metadata
 *     thread, and the source writes `thread_root_id` back into the cache rows (§3 threading).
 *  5. Cold-start bound: the first-ever sync force-triages only the most-recent `initialBacklog`; the
 *     rest stay cached (browsable) but un-emitted (§6 — "auto the obvious", don't re-triage the archive).
 *  6. Task context: an existing-task thread surfaces id+state+deadline/follow_up so the daemon
 *     transitions; a no-task thread yields `task.id === null` so the daemon creates one (§6).
 *  7. Resilience: a down connection (`client === null`) yields `[]`; one failed message doesn't abort
 *     the batch (the poll never throws).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNIPPET_MAX_LENGTH } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import type { MessageRow } from '../cache';
import { createCacheDaemonSource, resolveThreadRoots } from './cache-source';
import type { SourceConnection } from './cache-source';
import type {
  ImapClient,
  ImapFetchedMessage,
  ImapFetchQuery,
  ImapFolderInfo,
  ImapMailboxState,
  Unsubscribe,
} from '../imap/types';
import { capturingFetch, PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { MetadataClient } from '../metadata-client';

const MAILBOX = 'jan@acme.com';

/* -------------------------------------------------------------------------- */
/* Fake IMAP surface                                                           */
/* -------------------------------------------------------------------------- */

interface FixtureOpts {
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** Override the From: header / envelope address (default: petr@acme.com). */
  readonly from?: { name?: string; address: string };
}

/** A raw RFC822 message so `simpleParser` yields a real text/plain body for the LOCAL read. */
function rawEml(messageId: string, subject: string, body: string, opts: FixtureOpts): Buffer {
  const from = opts.from ?? { name: 'Petr', address: 'petr@acme.com' };
  const lines = [
    `From: ${from.name ? `${from.name} <${from.address}>` : from.address}`,
    `To: ${MAILBOX}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    'Date: Fri, 06 Jun 2026 08:30:00 +0000',
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references && opts.references.length > 0) {
    lines.push(`References: ${opts.references.join(' ')}`);
  }
  lines.push('', body, '');
  return Buffer.from(lines.join('\r\n'));
}

function fixture(
  uid: number,
  messageId: string,
  subject: string,
  body: string,
  opts: FixtureOpts = {},
): ImapFetchedMessage {
  const from = opts.from ?? { name: 'Petr', address: 'petr@acme.com' };
  return {
    uid,
    flags: new Set<string>(['\\Seen']),
    // Increasing internalDate with uid keeps "most recent" == "highest uid" for the backlog test.
    internalDate: new Date(`2026-06-06T08:${String(10 + uid).padStart(2, '0')}:00.000Z`),
    envelope: {
      messageId,
      subject,
      ...(opts.inReplyTo !== undefined ? { inReplyTo: opts.inReplyTo } : {}),
      from: [from],
    },
    references: opts.references ?? [],
    source: rawEml(messageId, subject, body, opts),
  };
}

/**
 * A programmable fake IMAP surface whose visible message set can GROW between polls (so we can drive
 * realistic incremental syncs: poll 1 full-resyncs `1:*`, a new arrival is then fetched via the
 * `<lastSeen+1>:*` incremental range). `uidNext` is derived from the current set, and `fetchByUid`
 * honors both the `1:*` (everything) and `N:*` (uid >= N) range shapes the sync plan produces.
 */
class ProgrammableFakeImap implements ImapClient {
  private messages: ImapFetchedMessage[];

  constructor(initial: readonly ImapFetchedMessage[] = []) {
    this.messages = [...initial];
  }

  /** Make a new message visible to the NEXT poll. */
  push(message: ImapFetchedMessage): void {
    this.messages.push(message);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }
  logout(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    /* nothing */
  }
  list(): Promise<readonly ImapFolderInfo[]> {
    return Promise.resolve([]);
  }
  openMailbox(): Promise<ImapMailboxState> {
    const maxUid = this.messages.reduce((m, x) => Math.max(m, x.uid), 0);
    return Promise.resolve({
      path: 'INBOX',
      uidValidity: 1n,
      uidNext: maxUid + 1,
      highestModseq: undefined,
      exists: this.messages.length,
      readOnly: true,
    });
  }
  async *fetchByUid(range: string, _query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    const lower = range.startsWith('1:') ? 1 : Number.parseInt(range.split(':')[0] ?? '1', 10);
    for (const message of this.messages) {
      if (message.uid < lower) continue;
      yield message;
    }
  }
  onClose(): Unsubscribe {
    return () => undefined;
  }
  onError(): Unsubscribe {
    return () => undefined;
  }
  onExists(): Unsubscribe {
    return () => undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

describe('createCacheDaemonSource — intent-derived (D35)', () => {
  let server: InProcessServer;
  let cache: MessageCache;
  let blobDir: string;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
    blobDir = mkdtempSync(join(tmpdir(), 'mailordomo-source-intent-'));
    cache = MessageCache.open({ dbPath: ':memory:', blobDir });
  });

  afterEach(() => {
    cache.close();
    server.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  function makeSource(
    client: ImapClient | null,
    metadata: MetadataClient,
    initialBacklog?: number,
  ) {
    const connection: SourceConnection = { client };
    return createCacheDaemonSource({
      connection,
      cache,
      metadata,
      mailbox: { address: MAILBOX },
      folders: [{ path: 'INBOX' }],
      projectId: PROJECT_A.id,
      now: () => '2026-06-06T09:00:00.000Z',
      // Quiet logger so a deliberately-failing message in the resilience test doesn't spam output.
      logger: () => undefined,
      ...(initialBacklog !== undefined ? { initialBacklog } : {}),
    });
  }

  /** The single INBOX folder's cache rows (UID ascending). */
  function inboxRows(): MessageRow[] {
    const folder = cache.getFolder(MAILBOX, 'INBOX');
    return folder ? cache.messagesInFolder(folder.id) : [];
  }

  /* ----- Intent 1: poll → cache → enumerate, end-to-end ------------------ */

  describe('poll → cache → enumerate (intent 1)', () => {
    it('turns a fake IMAP message into a DaemonMessage carrying the thread id, sanctioned fields, and a LOCAL body', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(
          1,
          '<invoice-1@acme.com>',
          'Invoice question',
          'Hi Jan, can you confirm the delivery timeline by Friday? Thanks, Petr.',
        ),
      ]);
      const source = makeSource(fake, client);

      const batch = await source.poll();
      expect(batch).toHaveLength(1);
      const message = batch[0];

      // Sanctioned fields surface for triage/extraction.
      expect(message?.subject).toBe('Invoice question');
      expect(message?.sender).toContain('petr@acme.com');
      expect(message?.snippet.length).toBeGreaterThan(0);

      // The body was read LOCALLY from the on-disk `.eml` (it carries the full prose).
      expect(message?.body).toContain('confirm the delivery timeline');

      // The threadId is the metadata-service thread id (the source upserts the thread FIRST).
      const threads = await client.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(message?.threadId);
      expect(threads[0]?.root_message_id).toBe('<invoice-1@acme.com>');
      expect(threads[0]?.subject).toBe('Invoice question');

      // The cache actually persisted a `.eml` on disk for this message (it is browsable locally).
      const rows = inboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eml_path).not.toBeNull();
    });

    it('carries the thread messages (with locally-read bodies) so the daemon can summarize', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(1, '<sum-1@acme.com>', 'Spec', 'Please review the attached spec and reply.'),
      ]);
      const batch = await makeSource(fake, client).poll();

      const message = batch[0];
      expect(message?.threadMessages.length).toBeGreaterThanOrEqual(1);
      // Bodies are present in the thread-message inputs (local read), not stripped.
      expect(message?.threadMessages.some((m) => m.body.includes('attached spec'))).toBe(true);
    });
  });

  /* ----- Intent 2: idempotency ------------------------------------------- */

  describe('idempotency — never reprocess (intent 2)', () => {
    it('a second poll with NO new mail emits nothing (no re-triage / double-promise)', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(1, '<m1@acme.com>', 'One', 'first body'),
        fixture(2, '<m2@acme.com>', 'Two', 'second body'),
      ]);
      const source = makeSource(fake, client);

      expect(await source.poll()).toHaveLength(2);
      expect(await source.poll()).toHaveLength(0); // unchanged mailbox ⇒ nothing re-emitted
    });

    it('emits ONLY the newly-arrived message on a later poll (cursor advances past seen UIDs)', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(1, '<old-1@acme.com>', 'Old one', 'old body'),
        fixture(2, '<old-2@acme.com>', 'Old two', 'old body two'),
      ]);
      const source = makeSource(fake, client);

      expect(await source.poll()).toHaveLength(2);

      // A genuinely new message arrives (higher UID) before the next poll.
      fake.push(fixture(3, '<fresh-3@acme.com>', 'Fresh arrival', 'fresh body'));

      const second = await source.poll();
      expect(second).toHaveLength(1);
      expect(second[0]?.subject).toBe('Fresh arrival');

      // And a THIRD poll with nothing new is again empty — the new one is not re-emitted.
      expect(await source.poll()).toHaveLength(0);

      // All three are cached/browsable even though only the new one was emitted on poll 2.
      expect(inboxRows()).toHaveLength(3);
    });
  });

  /* ----- Intent 3: golden rule #3 (the body never leaves) ---------------- */

  describe('golden rule #3 — the full body never crosses (intent 3)', () => {
    it('reads the full body locally but never sends it; the snippet is bounded below the marker', async () => {
      const capture = capturingFetch(server.fetch);
      const client = server.client(PROJECT_A, capture.fetch);

      // A body LONGER than the snippet bound, with a unique marker placed AFTER the first 200 chars.
      const marker = 'SECRET-MARKER-PAST-THE-SNIPPET-BOUND-9f3a';
      const prefix = 'lorem ipsum dolor sit amet '.repeat(12); // > 200 chars of filler
      expect(prefix.length).toBeGreaterThan(SNIPPET_MAX_LENGTH);
      const body = `${prefix}${marker}`;

      const fake = new ProgrammableFakeImap([
        fixture(1, '<privacy-1@acme.com>', 'Body privacy', body),
      ]);
      const batch = await makeSource(fake, client).poll();

      // The message was emitted (a correct, bounded snippet upserts cleanly to the strict server).
      expect(batch).toHaveLength(1);
      const message = batch[0];
      // The full body IS available locally for the LOCAL claude runner…
      expect(message?.body).toContain(marker);
      // …but the snippet is bounded at/under the sanctioned length and excludes the marker…
      expect((message?.snippet ?? '').length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
      expect(message?.snippet ?? '').not.toContain(marker);

      // …and the beyond-bound body text must NEVER appear in ANY outbound metadata request.
      expect(capture.captured.length).toBeGreaterThan(0); // we DID talk to the server (upsertThread)
      for (const request of capture.captured) {
        expect(request.rawBody ?? '').not.toContain(marker);
      }
    });

    it('no outbound request body carries a body/bodyText field (only the sanctioned thread shape)', async () => {
      const capture = capturingFetch(server.fetch);
      const client = server.client(PROJECT_A, capture.fetch);
      const fake = new ProgrammableFakeImap([
        fixture(
          1,
          '<shape-1@acme.com>',
          'Shape',
          'a representative body line that should stay local',
        ),
      ]);
      await makeSource(fake, client).poll();

      const writes = capture.captured.filter((r) => r.body !== undefined);
      expect(writes.length).toBeGreaterThan(0);
      for (const request of writes) {
        const keys = Object.keys((request.body as Record<string, unknown>) ?? {});
        // The privacy boundary: no body-ful key ever crosses (the thread DTO is subject/snippet/sender).
        expect(keys).not.toContain('body');
        expect(keys).not.toContain('bodyText');
        expect(keys).not.toContain('text');
      }
    });

    it('clamps an oversized snippet to the sanctioned bound (the §5 exception is BOUNDED)', async () => {
      const client = server.client(PROJECT_A);
      const body = 'x'.repeat(SNIPPET_MAX_LENGTH + 500);
      const fake = new ProgrammableFakeImap([fixture(1, '<clamp-1@acme.com>', 'Clamp', body)]);
      const batch = await makeSource(fake, client).poll();

      // The emitted message's snippet is clamped (so the upsert is accepted by the strict server).
      expect(batch).toHaveLength(1);
      expect((batch[0]?.snippet ?? '').length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
      // The thread DID land on the server (an unclamped snippet would have been rejected), with a
      // bounded snippet — the §5 exception is BOUNDED, never the full body.
      const threads = await client.listThreads();
      expect(threads).toHaveLength(1);
      expect((threads[0]?.snippet ?? '').length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
    });
  });

  /* ----- Intent 4: threading -------------------------------------------- */

  describe('threading — one thread per conversation (intent 4)', () => {
    /** Small helper so the threading tests read cleanly. */
    function fake(messages: readonly ImapFetchedMessage[]): ProgrammableFakeImap {
      return new ProgrammableFakeImap(messages);
    }

    it('groups a reply under the SAME metadata thread as the original (one thread, not two)', async () => {
      const client = server.client(PROJECT_A);
      const original = fixture(1, '<root-1@acme.com>', 'Project kickoff', 'Original message body.');
      const reply = fixture(2, '<reply-2@acme.com>', 'Re: Project kickoff', 'A reply body.', {
        inReplyTo: '<root-1@acme.com>',
        references: ['<root-1@acme.com>'],
      });
      const batch = await makeSource(fake([original, reply]), client).poll();

      // Both messages were emitted, and they share ONE metadata thread id.
      expect(batch).toHaveLength(2);
      const threadIds = new Set(batch.map((m) => m.threadId));
      expect(threadIds.size).toBe(1);

      // The server has exactly one thread, rooted at the ORIGINAL message id.
      const threads = await client.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.root_message_id).toBe('<root-1@acme.com>');
    });

    it('writes the JWZ thread_root_id back into the cache rows (closes the never-populated gap)', async () => {
      const client = server.client(PROJECT_A);
      const original = fixture(1, '<rootw-1@acme.com>', 'Kickoff', 'Original.');
      const reply = fixture(2, '<replyw-2@acme.com>', 'Re: Kickoff', 'Reply.', {
        inReplyTo: '<rootw-1@acme.com>',
        references: ['<rootw-1@acme.com>'],
      });
      await makeSource(fake([original, reply]), client).poll();

      const rows = inboxRows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.thread_root_id).toBe('<rootw-1@acme.com>'); // both rows point at the original root
      }
    });

    it('a reply that arrives on a LATER poll still joins the original thread', async () => {
      const client = server.client(PROJECT_A);
      const original = fixture(1, '<late-root@acme.com>', 'Topic', 'Original.');
      const fakeImap = fake([original]);
      const source = makeSource(fakeImap, client);

      const first = await source.poll();
      expect(first).toHaveLength(1);
      const originalThreadId = first[0]?.threadId;

      fakeImap.push(
        fixture(2, '<late-reply@acme.com>', 'Re: Topic', 'A later reply.', {
          inReplyTo: '<late-root@acme.com>',
          references: ['<late-root@acme.com>'],
        }),
      );
      const second = await source.poll();
      expect(second).toHaveLength(1);
      expect(second[0]?.threadId).toBe(originalThreadId); // same thread across polls
      expect(await client.listThreads()).toHaveLength(1);
    });
  });

  /* ----- Intent 5: cold-start backlog bound ----------------------------- */

  describe('cold-start backlog bound (intent 5)', () => {
    it('emits only the most-recent `initialBacklog` on the first-ever sync, caching the rest', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(1, '<a@acme.com>', 'Oldest', 'oldest body'),
        fixture(2, '<b@acme.com>', 'Middle', 'middle body'),
        fixture(3, '<c@acme.com>', 'Newest', 'newest body'),
      ]);
      const source = makeSource(fake, client, 2); // backlog of 2 over 3 messages

      const batch = await source.poll();
      expect(batch).toHaveLength(2);
      // The two MOST-RECENT (highest UID / latest date), not the archive.
      expect(batch.map((m) => m.subject)).toEqual(['Middle', 'Newest']);

      // But ALL three are cached and browsable (the archive is not force-triaged, merely not emitted).
      expect(inboxRows()).toHaveLength(3);
    });

    it('uses the documented default backlog (25) when none is configured', async () => {
      const client = server.client(PROJECT_A);
      // 30 messages > the default 25 ⇒ exactly 25 emitted, the 25 most recent.
      const many = Array.from({ length: 30 }, (_unused, i) =>
        fixture(i + 1, `<bulk-${i + 1}@acme.com>`, `Subject ${i + 1}`, `body ${i + 1}`),
      );
      const source = makeSource(new ProgrammableFakeImap(many), client); // no initialBacklog → default

      const batch = await source.poll();
      expect(batch).toHaveLength(25);
      // The oldest five (uids 1..5) are NOT in the emitted set.
      const emittedSubjects = new Set(batch.map((m) => m.subject));
      expect(emittedSubjects.has('Subject 1')).toBe(false);
      expect(emittedSubjects.has('Subject 5')).toBe(false);
      expect(emittedSubjects.has('Subject 6')).toBe(true);
      expect(emittedSubjects.has('Subject 30')).toBe(true);
      expect(inboxRows()).toHaveLength(30); // all cached
    });
  });

  /* ----- Intent 6: task context ----------------------------------------- */

  describe('task context (intent 6)', () => {
    it('a brand-new thread (no task yet) yields task.id === null', async () => {
      const client = server.client(PROJECT_A);
      const fake = new ProgrammableFakeImap([
        fixture(1, '<nt-1@acme.com>', 'New thread', 'A new message with no task yet.'),
      ]);
      const batch = await makeSource(fake, client).poll();
      expect(batch[0]?.task.id).toBeNull();
      expect(batch[0]?.task.state).toBe('needs-reply');
    });

    it('a thread that already has a task surfaces its id + state + deadline/follow_up', async () => {
      const client = server.client(PROJECT_A);
      // Pre-create the thread + a task in `waiting` with a follow-up deadline (as the daemon would).
      const existing = await client.upsertThread({
        project_id: PROJECT_A.id,
        mailbox_address: MAILBOX,
        root_message_id: '<has-task@acme.com>',
        subject: 'Existing',
        snippet: 'preexisting snippet',
        sender: 'Petr <petr@acme.com>',
      });
      const task = await client.createTask({
        thread_id: existing.id,
        state: 'waiting',
        follow_up_at: '2026-06-10T09:00:00.000Z',
        deadline: '2026-06-12T09:00:00.000Z',
      });

      const fake = new ProgrammableFakeImap([
        fixture(1, '<has-task@acme.com>', 'Existing', 'A new message on an existing thread.'),
      ]);
      const batch = await makeSource(fake, client).poll();

      const ctx = batch[0]?.task;
      expect(ctx?.id).toBe(task.id);
      expect(ctx?.state).toBe('waiting');
      expect(ctx?.followUpAtIso).toBe('2026-06-10T09:00:00.000Z');
      expect(ctx?.deadlineIso).toBe('2026-06-12T09:00:00.000Z');
    });

    it('prefers the ACTIVE (non-done) task when a thread has both a done and an open task', async () => {
      const client = server.client(PROJECT_A);
      const existing = await client.upsertThread({
        project_id: PROJECT_A.id,
        mailbox_address: MAILBOX,
        root_message_id: '<two-tasks@acme.com>',
        subject: 'Two tasks',
        snippet: 'snip',
        sender: 'Petr <petr@acme.com>',
      });
      await client.createTask({ thread_id: existing.id, state: 'done' });
      const open = await client.createTask({ thread_id: existing.id, state: 'needs-reply' });

      const fake = new ProgrammableFakeImap([
        fixture(
          1,
          '<two-tasks@acme.com>',
          'Two tasks',
          'A fresh inbound on a thread with 2 tasks.',
        ),
      ]);
      const batch = await makeSource(fake, client).poll();
      expect(batch[0]?.task.id).toBe(open.id);
      expect(batch[0]?.task.state).toBe('needs-reply');
    });
  });

  /* ----- Intent 7: resilience ------------------------------------------- */

  describe('resilience (intent 7)', () => {
    it('returns [] when the IMAP connection is down (client === null)', async () => {
      const client = server.client(PROJECT_A);
      const source = makeSource(null, client);
      expect(await source.poll()).toEqual([]);
      // Nothing was upserted to the server either.
      expect(await client.listThreads()).toHaveLength(0);
    });

    it('a single failing message does not abort the rest of the batch', async () => {
      // Force a HARD per-message failure: a metadata client whose upsertThread rejects for ONE root.
      const realClient = server.client(PROJECT_A);
      const failingRoot = '<boom@acme.com>';
      const guardedMetadata = {
        upsertThread: (req: Parameters<MetadataClient['upsertThread']>[0]) => {
          if (req.root_message_id === failingRoot) {
            return Promise.reject(new Error('simulated upsert failure'));
          }
          return realClient.upsertThread(req);
        },
        listTasks: (threadId?: string) => realClient.listTasks(threadId),
      };

      const fake = new ProgrammableFakeImap([
        fixture(1, '<ok-1@acme.com>', 'Fine one', 'body one'),
        fixture(2, failingRoot, 'Doomed', 'body two'),
        fixture(3, '<ok-3@acme.com>', 'Fine three', 'body three'),
      ]);
      const source = createCacheDaemonSource({
        connection: { client: fake },
        cache,
        metadata: guardedMetadata,
        mailbox: { address: MAILBOX },
        folders: [{ path: 'INBOX' }],
        projectId: PROJECT_A.id,
        now: () => '2026-06-06T09:00:00.000Z',
        logger: () => undefined,
      });

      const batch = await source.poll();
      // The two healthy messages still came through; the failing one was skipped, not fatal.
      expect(batch.map((m) => m.subject).sort()).toEqual(['Fine one', 'Fine three']);
      // Exactly the two healthy threads were upserted to the server (the doomed one never landed).
      const threads = await realClient.listThreads();
      expect(threads.map((t) => t.root_message_id).sort()).toEqual([
        '<ok-1@acme.com>',
        '<ok-3@acme.com>',
      ]);
    });
  });

  /* ----- resolveThreadRoots: the exported PURE helper -------------------- */

  describe('resolveThreadRoots (pure helper)', () => {
    /** Build a minimal MessageRow good enough for the pure rooter. */
    function row(
      id: number,
      uid: number,
      messageId: string | null,
      opts: { inReplyTo?: string; references?: string[]; date?: string } = {},
    ): MessageRow {
      return {
        id,
        folder_id: 1,
        uid,
        uid_validity: '1',
        message_id: messageId,
        in_reply_to: opts.inReplyTo ?? null,
        references_json: opts.references ? JSON.stringify(opts.references) : null,
        thread_root_id: null,
        subject: `s${id}`,
        sender: 'petr@acme.com',
        snippet: null,
        internal_date: opts.date ?? `2026-06-06T08:0${id}:00.000Z`,
        size: null,
        flags_json: null,
        eml_path: null,
      };
    }

    it('roots a reply chain at the ORIGINAL message id (one root for the whole conversation)', () => {
      const rows = [
        row(1, 1, '<orig@acme.com>'),
        row(2, 2, '<reply@acme.com>', {
          inReplyTo: '<orig@acme.com>',
          references: ['<orig@acme.com>'],
        }),
      ];
      const roots = resolveThreadRoots(rows);
      expect(roots.get(1)).toBe('<orig@acme.com>');
      expect(roots.get(2)).toBe('<orig@acme.com>'); // the reply shares the original's root
      expect(new Set(roots.values()).size).toBe(1);
    });

    it('groups MULTIPLE siblings under a referenced-but-unfetched original (e.g. the root lives in Sent)', () => {
      // Two replies in this folder both reference an original we never synced here. JWZ keeps the
      // empty (unfetched) original as a grouping root because it has >1 child, so both siblings share
      // the original id — exactly the docstring's "root lives in Sent" intent.
      const rows = [
        row(1, 5, '<reply-a@acme.com>', {
          inReplyTo: '<unseen-original@acme.com>',
          references: ['<unseen-original@acme.com>'],
        }),
        row(2, 6, '<reply-b@acme.com>', {
          inReplyTo: '<unseen-original@acme.com>',
          references: ['<unseen-original@acme.com>'],
        }),
      ];
      const roots = resolveThreadRoots(rows);
      expect(roots.get(1)).toBe('<unseen-original@acme.com>');
      expect(roots.get(2)).toBe('<unseen-original@acme.com>');
      expect(new Set(roots.values()).size).toBe(1);
    });

    it('FINDING: a LONE reply to an unfetched original self-roots (docstring overstates the Sent case)', () => {
      // A SINGLE reply referencing an original absent from this folder. The implementation's docstring
      // claims it would group under the unfetched original "e.g. a root that lives in Sent", but JWZ
      // prunes the empty single-child container, so the tree root becomes the reply, and the rooter
      // falls to `earliestReal` = the reply's OWN id. This is spec-BENIGN (the message self-roots
      // harmlessly and merges correctly once the original or a sibling is synced — see the multi-sibling
      // case above, and the e2e "reply arrives on a later poll" test), but it diverges from the
      // docstring. Asserting the ACTUAL behavior so the test does not encode an aspiration. (Reported.)
      const rows = [
        row(1, 5, '<the-reply@acme.com>', {
          inReplyTo: '<unseen-original@acme.com>',
          references: ['<unseen-original@acme.com>'],
        }),
      ];
      const roots = resolveThreadRoots(rows);
      expect(roots.get(1)).toBe('<the-reply@acme.com>');
    });

    it('gives two unrelated messages two distinct roots (does NOT over-merge)', () => {
      const rows = [row(1, 1, '<a@acme.com>'), row(2, 2, '<b@acme.com>')];
      const roots = resolveThreadRoots(rows);
      expect(roots.get(1)).toBe('<a@acme.com>');
      expect(roots.get(2)).toBe('<b@acme.com>');
      expect(new Set(roots.values()).size).toBe(2);
    });

    it('produces a stable, contained synthetic root for a message with NO Message-ID', () => {
      const rows = [row(1, 7, null)];
      const roots = resolveThreadRoots(rows);
      const root = roots.get(1);
      expect(root).toBeDefined();
      // A non-empty, contained synthetic id keyed on (folder, uid) — a valid upsert key.
      expect(root).toContain('mailordomo-cache');
      expect(root).toContain('-7@');
    });
  });
});
