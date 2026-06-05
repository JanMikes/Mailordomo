import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageCache } from '../cache/cache';
import { MailboxSync } from './mailbox-sync';
import { computeSyncPlan } from './sync-plan';
import type { ImapClient, ImapFetchQuery, ImapFetchedMessage, ImapMailboxState } from './types';

/**
 * Load-bearing suite for the sync DELTA logic (PROJECT.md §4: own reconnect/resync; CONDSTORE/
 * QRESYNC deltas; uidValidity invalidation) and §5 (the cache is a disposable, faithful mirror
 * keyed by mailbox/uidValidity/uid). Everything runs against a FAKE ImapClient implementing
 * `imap/types.ts` — NO live mailbox, per PLAN.md §7 / §5.
 */

// ---------------------------------------------------------------------------------------------
// computeSyncPlan — pure decision table (local cursor × server state → plan)
// ---------------------------------------------------------------------------------------------

describe('computeSyncPlan — full resync conditions', () => {
  it('full-resync (no-local-state) when nothing has been synced yet', () => {
    expect(computeSyncPlan({ lastSeenUid: 0 }, { uidValidity: '100', uidNext: 5 })).toEqual({
      kind: 'full-resync',
      reason: 'no-local-state',
      fetchRange: '1:*',
      serverUidValidity: '100',
    });
  });

  it('full-resync (no-local-state) when uidValidity is unknown even if a uid was seen', () => {
    expect(
      computeSyncPlan({ uidValidity: null, lastSeenUid: 7 }, { uidValidity: '100', uidNext: 9 }),
    ).toMatchObject({ kind: 'full-resync', reason: 'no-local-state' });
  });

  it('full-resync (uidvalidity-changed) when the server invalidated our UIDs', () => {
    expect(
      computeSyncPlan({ uidValidity: '100', lastSeenUid: 4 }, { uidValidity: '200', uidNext: 9 }),
    ).toEqual({
      kind: 'full-resync',
      reason: 'uidvalidity-changed',
      fetchRange: '1:*',
      serverUidValidity: '200',
    });
  });
});

describe('computeSyncPlan — incremental vs up-to-date', () => {
  it('incremental new-range when uidNext advanced past the last-seen uid', () => {
    expect(
      computeSyncPlan({ uidValidity: '100', lastSeenUid: 4 }, { uidValidity: '100', uidNext: 9 }),
    ).toEqual({ kind: 'incremental', fetchNewRange: '5:*', changedSince: null });
  });

  it('up-to-date when uidNext is exactly last-seen + 1 and no modseq movement', () => {
    expect(
      computeSyncPlan(
        { uidValidity: '100', lastSeenUid: 4, highestModseq: '10' },
        { uidValidity: '100', uidNext: 5, highestModseq: '10' },
      ),
    ).toEqual({ kind: 'up-to-date' });
  });

  it('incremental changedSince-only (flag delta) when modseq moved but no new uids', () => {
    expect(
      computeSyncPlan(
        { uidValidity: '100', lastSeenUid: 4, highestModseq: '10' },
        { uidValidity: '100', uidNext: 5, highestModseq: '20' },
      ),
    ).toEqual({ kind: 'incremental', fetchNewRange: null, changedSince: '10' });
  });

  it('incremental with BOTH a new range and a flag delta', () => {
    expect(
      computeSyncPlan(
        { uidValidity: '100', lastSeenUid: 4, highestModseq: '10' },
        { uidValidity: '100', uidNext: 9, highestModseq: '20' },
      ),
    ).toEqual({ kind: 'incremental', fetchNewRange: '5:*', changedSince: '10' });
  });

  it('cannot compute a flag delta without a local modseq baseline ⇒ up-to-date', () => {
    expect(
      computeSyncPlan(
        { uidValidity: '100', lastSeenUid: 4 },
        { uidValidity: '100', uidNext: 5, highestModseq: '20' },
      ),
    ).toEqual({ kind: 'up-to-date' });
  });

  it('ignores a vanished server modseq (no delta to fetch) ⇒ up-to-date', () => {
    expect(
      computeSyncPlan(
        { uidValidity: '100', lastSeenUid: 4, highestModseq: '10' },
        { uidValidity: '100', uidNext: 5, highestModseq: null },
      ),
    ).toEqual({ kind: 'up-to-date' });
  });
});

// ---------------------------------------------------------------------------------------------
// MailboxSync — drive syncOnce() over a configurable fake ImapClient
// ---------------------------------------------------------------------------------------------

const MAILBOX = 'j.mikes@me.com';
const FOLDER = 'INBOX';

function serverState(
  overrides: Partial<ImapMailboxState> & Pick<ImapMailboxState, 'uidValidity' | 'uidNext'>,
): ImapMailboxState {
  return {
    path: FOLDER,
    highestModseq: undefined,
    exists: 0,
    readOnly: true,
    ...overrides,
  };
}

function fullMsg(
  uid: number,
  messageId: string,
  subject: string,
  modseq?: bigint,
): ImapFetchedMessage {
  return {
    uid,
    modseq,
    flags: new Set(['\\Seen']),
    internalDate: new Date('2026-01-01T00:00:00Z'),
    size: 100 + uid,
    envelope: { messageId, subject, from: [{ name: 'Acme', address: 'billing@acme.com' }] },
    references: [],
  };
}

/** A flag-only fetched message: exactly what a CONDSTORE `changedSince` delta yields. */
function flagOnlyMsg(uid: number, modseq: bigint, flags: string[]): ImapFetchedMessage {
  return { uid, modseq, flags: new Set(flags) };
}

/** Configurable in-memory fake of the injected IMAP surface — records what it was asked for. */
class FakeImapClient implements ImapClient {
  public readonly opened: Array<{ path: string; readOnly: boolean | undefined }> = [];
  public readonly fetched: Array<{ range: string; query: ImapFetchQuery }> = [];

  constructor(
    private state: ImapMailboxState,
    private messages: readonly ImapFetchedMessage[],
  ) {}

  setState(state: ImapMailboxState): void {
    this.state = state;
  }

  setMessages(messages: readonly ImapFetchedMessage[]): void {
    this.messages = messages;
  }

  async connect(): Promise<void> {}
  async logout(): Promise<void> {}
  close(): void {}
  async list(): Promise<readonly never[]> {
    return [];
  }

  async openMailbox(path: string, options?: { readOnly?: boolean }): Promise<ImapMailboxState> {
    this.opened.push({ path, readOnly: options?.readOnly });
    return this.state;
  }

  async *fetchByUid(range: string, query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    this.fetched.push({ range, query });
    for (const message of this.messages) yield message;
  }

  onClose(): () => void {
    return () => undefined;
  }
  onError(): () => void {
    return () => undefined;
  }
  onExists(): () => void {
    return () => undefined;
  }
}

describe('MailboxSync.syncOnce — full resync, then incremental, then up-to-date', () => {
  it('caches messages, advances the cursor, and opens READ-ONLY by default', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(serverState({ uidValidity: 100n, uidNext: 3 }), [
      fullMsg(1, '<a@x>', 'Hello'),
      fullMsg(2, '<b@x>', 'World'),
    ]);
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });

    const result = await sync.syncOnce();

    expect(result.plan.kind).toBe('full-resync');
    expect(result.fetched).toBe(2);
    expect(result.lastSeenUid).toBe(2);
    expect(client.opened[0]?.readOnly).toBe(true); // checkpoint runs strictly read-only
    expect(client.fetched[0]?.range).toBe('1:*');

    const folder = cache.getFolder(MAILBOX, FOLDER);
    expect(folder?.last_seen_uid).toBe(2);
    expect(folder?.uid_validity).toBe('100');
    const folderId = folder?.id ?? -1;
    expect(cache.messagesInFolder(folderId)).toHaveLength(2);
    expect(cache.getMessageByUid(folderId, 1)?.subject).toBe('Hello');
    expect(cache.getMessageByUid(folderId, 1)?.sender).toBe('Acme <billing@acme.com>');
    expect(cache.getMessagesByMessageId('<a@x>')).toHaveLength(1);
    cache.close();
  });

  it('fetches only the new UID range on the next pass and advances the cursor', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(serverState({ uidValidity: 100n, uidNext: 3 }), [
      fullMsg(1, '<a@x>', 'Hello'),
      fullMsg(2, '<b@x>', 'World'),
    ]);
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });
    await sync.syncOnce();

    client.setState(serverState({ uidValidity: 100n, uidNext: 4 }));
    client.setMessages([fullMsg(3, '<c@x>', 'Third')]);
    const second = await sync.syncOnce();

    expect(second.plan).toMatchObject({ kind: 'incremental', fetchNewRange: '3:*' });
    expect(client.fetched.at(-1)?.range).toBe('3:*'); // ONLY the new range, not 1:*
    expect(second.lastSeenUid).toBe(3);
    const folderId = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    expect(cache.getMessageByUid(folderId, 3)?.subject).toBe('Third');
    cache.close();
  });

  it('reports up-to-date and issues NO fetch when nothing changed', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(serverState({ uidValidity: 100n, uidNext: 3 }), [
      fullMsg(1, '<a@x>', 'Hello'),
      fullMsg(2, '<b@x>', 'World'),
    ]);
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });
    await sync.syncOnce();
    const fetchesAfterFirst = client.fetched.length;

    const second = await sync.syncOnce();

    expect(second.plan.kind).toBe('up-to-date');
    expect(second.fetched).toBe(0);
    expect(client.fetched.length).toBe(fetchesAfterFirst); // no new fetchByUid call
    cache.close();
  });

  it('derives References from the envelope In-Reply-To when no References list is fetched', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(serverState({ uidValidity: 100n, uidNext: 2 }), [
      { uid: 1, flags: new Set<string>(), envelope: { messageId: '<r@x>', inReplyTo: '<root@x>' } },
    ]);
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });
    await sync.syncOnce();

    const folderId = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    const row = cache.getMessageByUid(folderId, 1);
    expect(row?.in_reply_to).toBe('<root@x>');
    expect(row?.references_json).toBe(JSON.stringify(['<root@x>']));
    cache.close();
  });
});

describe('MailboxSync.syncOnce — uidValidity change invalidates then refetches (rebuild path)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mailordomo-sync-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('wipes the old (mailbox,uidValidity) slice on disk + in the DB, then rebuilds under the new id', async () => {
    const cache = MessageCache.open({
      dbPath: path.join(dir, 'cache.db'),
      blobDir: path.join(dir, 'blobs'),
    });
    const withSource = (uid: number, id: string): ImapFetchedMessage => ({
      ...fullMsg(uid, id, `subject ${uid}`),
      source: Buffer.from(`raw-${uid}`),
    });

    const client = new FakeImapClient(serverState({ uidValidity: 100n, uidNext: 3 }), [
      withSource(1, '<a@x>'),
      withSource(2, '<b@x>'),
    ]);
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });
    await sync.syncOnce();

    const folderId = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    const oldEml = cache.getMessageByUid(folderId, 1)?.eml_path ?? '';
    expect(existsSync(oldEml)).toBe(true);
    expect(oldEml).toContain(`${path.sep}100${path.sep}`); // keyed by the old uidValidity

    // uidValidity changes ⇒ the server says "your UIDs are void".
    client.setState(serverState({ uidValidity: 999n, uidNext: 3 }));
    client.setMessages([withSource(1, '<a@x>'), withSource(2, '<b@x>')]);
    const second = await sync.syncOnce();

    expect(second.invalidated).toBe(true);
    expect(second.plan).toMatchObject({ kind: 'full-resync', reason: 'uidvalidity-changed' });
    expect(existsSync(oldEml)).toBe(false); // old slice wiped from disk

    const folder = cache.getFolder(MAILBOX, FOLDER);
    expect(folder?.uid_validity).toBe('999');
    expect(folder?.last_seen_uid).toBe(2);
    const rows = cache.messagesInFolder(folderId);
    expect(rows).toHaveLength(2); // rebuilt, not duplicated
    expect(rows.every((r) => r.uid_validity === '999')).toBe(true);
    const newEml = cache.getMessageByUid(folderId, 1)?.eml_path ?? '';
    expect(newEml).toContain(`${path.sep}999${path.sep}`);
    expect(existsSync(newEml)).toBe(true);
    cache.close();
  });
});

describe('MailboxSync.syncOnce — CONDSTORE flag delta must not corrupt the cached mirror', () => {
  it('updates flags on an already-cached message WITHOUT erasing its envelope', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(
      serverState({ uidValidity: 100n, uidNext: 3, highestModseq: 10n }),
      [fullMsg(1, '<a@x>', 'Hello', 5n), fullMsg(2, '<b@x>', 'World', 8n)],
    );
    const sync = new MailboxSync(client, cache, { mailboxAddress: MAILBOX, folderPath: FOLDER });
    await sync.syncOnce();

    const folderId = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    expect(cache.getMessageByUid(folderId, 1)?.subject).toBe('Hello');

    // A flag changed on uid 1 (e.g. \Flagged) ⇒ modseq bumps; CONDSTORE returns a flags-ONLY row.
    client.setState(serverState({ uidValidity: 100n, uidNext: 3, highestModseq: 20n }));
    client.setMessages([flagOnlyMsg(1, 20n, ['\\Seen', '\\Flagged'])]);
    const second = await sync.syncOnce();

    expect(second.plan.kind).toBe('incremental');
    if (second.plan.kind === 'incremental') {
      expect(second.plan.changedSince).not.toBeNull();
    }

    const row = cache.getMessageByUid(folderId, 1);
    // The flag delta SHOULD update flags...
    expect(row?.flags_json).toBe(JSON.stringify(['\\Seen', '\\Flagged']));
    // ...but the cache is a faithful mirror (§5): the envelope must survive a flags-only delta.
    expect(row?.subject).toBe('Hello');
    expect(row?.message_id).toBe('<a@x>');
    cache.close();
  });
});
