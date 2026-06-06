/**
 * Live daemon source SMOKE coverage (PLAN.md D35) — drives `createCacheDaemonSource` over a FAKE IMAP
 * surface + the REAL in-memory {@link MessageCache} (with an on-disk blob dir so `.eml` bodies exist) +
 * the REAL in-process metadata server (via the integration harness). Asserts the load-bearing wiring:
 *   - poll → MailboxSync → cache → enumerate emits one {@link DaemonMessage} per new message;
 *   - the thread is upserted (subject/snippet/sender) and the body is read LOCALLY from `.eml`;
 *   - a second poll is idempotent (no new UIDs ⇒ no re-emit);
 *   - the cold-start backlog cap bounds the first-ever sync;
 *   - a disconnected client yields `[]`;
 *   - GOLDEN RULE #3: no body crosses to the metadata server (only the sanctioned thread fields).
 * The separate test-author hardens the matrix; this is the implementer's net.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageCache } from '../cache';
import { createCacheDaemonSource } from './cache-source';
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

/** A raw RFC822 message (so `simpleParser` yields a plain-text body for the local read). */
function rawEml(messageId: string, subject: string, body: string): Buffer {
  return Buffer.from(
    [
      'From: Petr <petr@acme.com>',
      `To: ${MAILBOX}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'Date: Fri, 06 Jun 2026 08:30:00 +0000',
      '',
      body,
      '',
    ].join('\r\n'),
  );
}

function fixture(
  uid: number,
  messageId: string,
  subject: string,
  body: string,
): ImapFetchedMessage {
  return {
    uid,
    flags: new Set<string>(['\\Seen']),
    internalDate: new Date(`2026-06-06T08:${10 + uid}:00.000Z`),
    envelope: {
      messageId,
      subject,
      from: [{ name: 'Petr', address: 'petr@acme.com' }],
    },
    references: [],
    source: rawEml(messageId, subject, body),
  };
}

/** A fake IMAP surface that yields a fixed set of messages and reports a matching uidNext. */
class FakeImapClient implements ImapClient {
  constructor(private readonly messages: readonly ImapFetchedMessage[]) {}
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
    // The source only ever full-resyncs (`1:*`) or incrementally fetches above last-seen; for the
    // smoke fixtures we yield everything on a full range and nothing otherwise.
    if (range.startsWith('1:')) {
      for (const message of this.messages) yield message;
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

describe('createCacheDaemonSource — live IMAP→cache→enumerate (D35)', () => {
  let server: InProcessServer;
  let cache: MessageCache;
  let blobDir: string;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
    blobDir = mkdtempSync(join(tmpdir(), 'mailordomo-source-'));
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
      ...(initialBacklog !== undefined ? { initialBacklog } : {}),
    });
  }

  it('syncs, upserts the thread, and emits a DaemonMessage with the LOCAL body', async () => {
    const client = server.client(PROJECT_A);
    const fake = new FakeImapClient([
      fixture(
        1,
        '<invoice-1@acme.com>',
        'Invoice question',
        'Can you confirm the timeline by Friday?',
      ),
    ]);
    const source = makeSource(fake, client);

    const batch = await source.poll();
    expect(batch).toHaveLength(1);
    const message = batch[0];
    expect(message?.subject).toBe('Invoice question');
    expect(message?.sender).toContain('petr@acme.com');
    expect(message?.body).toContain('confirm the timeline'); // body read locally from `.eml`
    expect(message?.snippet.length).toBeGreaterThan(0);
    expect(message?.task.id).toBeNull(); // brand-new thread (no task yet)

    // The thread was upserted to the REAL metadata server with its sanctioned fields.
    const threads = await client.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(message?.threadId);
    expect(threads[0]?.root_message_id).toBe('<invoice-1@acme.com>');
  });

  it('is idempotent — a second poll with no new UIDs emits nothing', async () => {
    const client = server.client(PROJECT_A);
    const fake = new FakeImapClient([
      fixture(1, '<m1@acme.com>', 'One', 'first body'),
      fixture(2, '<m2@acme.com>', 'Two', 'second body'),
    ]);
    const source = makeSource(fake, client);

    expect(await source.poll()).toHaveLength(2);
    expect(await source.poll()).toHaveLength(0); // no new arrivals ⇒ no re-emit
  });

  it('bounds the FIRST-ever sync to the most-recent `initialBacklog` messages', async () => {
    const client = server.client(PROJECT_A);
    const fake = new FakeImapClient([
      fixture(1, '<old@acme.com>', 'Old', 'older body'),
      fixture(2, '<new@acme.com>', 'New', 'newer body'),
    ]);
    const source = makeSource(fake, client, 1);

    const batch = await source.poll();
    expect(batch).toHaveLength(1);
    expect(batch[0]?.subject).toBe('New'); // the most-recent one, not the archive
  });

  it('returns [] when the IMAP connection is down (client === null)', async () => {
    const client = server.client(PROJECT_A);
    const source = makeSource(null, client);
    expect(await source.poll()).toEqual([]);
  });

  it('GOLDEN RULE #3 — the FULL body never crosses (only a bounded snippet may)', async () => {
    const capture = capturingFetch(server.fetch);
    const client = server.client(PROJECT_A, capture.fetch);
    // A body LONGER than the sanctioned snippet bound: a unique marker placed AFTER the first 200
    // chars must never cross. (A bounded prefix CAN legitimately appear in the sanctioned `snippet` —
    // that is the §5 exception; the invariant under test is that the full body does not leave.)
    const marker = 'SECRET-BEYOND-THE-SNIPPET-BOUND';
    const body = `${'word '.repeat(60)}${marker}`; // ~300 chars of filler, then the marker
    const fake = new FakeImapClient([fixture(1, '<b1@acme.com>', 'Body privacy', body)]);
    const source = makeSource(fake, client);

    const batch = await source.poll();
    expect(batch[0]?.body).toContain(marker); // the full body IS read locally…
    expect(batch[0]?.snippet).not.toContain(marker); // …the snippet is bounded below the marker…

    // …and the beyond-snippet body text must NEVER appear in any outbound metadata request.
    for (const request of capture.captured) {
      expect(request.rawBody ?? '').not.toContain(marker);
    }
  });
});
