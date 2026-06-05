import { describe, expect, it } from 'vitest';
import { MessageCache } from '../cache/cache';
import { backoffDelay } from './backoff';
import { ResilientImapConnection } from './connection';
import { MailboxSync } from './mailbox-sync';
import { computeSyncPlan } from './sync-plan';
import type {
  ImapClient,
  ImapFetchedMessage,
  ImapFetchQuery,
  ImapFolderInfo,
  ImapMailboxState,
  Unsubscribe,
} from './types';

/**
 * Smoke coverage that ALSO demonstrates the injection seam: the sync engine and the reconnect loop
 * are driven entirely by a FAKE `ImapClient` and a fake clock — no live server. The separate test
 * author hardens the delta matrix on top of these same seams.
 */

const STATE: ImapMailboxState = {
  path: 'INBOX',
  uidValidity: 100n,
  uidNext: 3,
  highestModseq: undefined,
  exists: 2,
  readOnly: true,
};

function msg(uid: number, messageId: string): ImapFetchedMessage {
  return {
    uid,
    flags: new Set<string>(['\\Seen']),
    envelope: { messageId, subject: `subject ${uid}`, from: [{ address: 'a@x' }] },
    references: [],
  };
}

/** A minimal in-memory fake of the injected IMAP surface. */
class FakeImapClient implements ImapClient {
  constructor(
    private state: ImapMailboxState,
    private messages: ImapFetchedMessage[],
  ) {}
  async connect(): Promise<void> {
    /* fake: nothing to connect */
  }
  async logout(): Promise<void> {
    /* fake: nothing to log out */
  }
  close(): void {
    /* fake: nothing to close */
  }
  async list(): Promise<readonly ImapFolderInfo[]> {
    return [];
  }
  async openMailbox(): Promise<ImapMailboxState> {
    return this.state;
  }
  async *fetchByUid(_range: string, _query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    for (const m of this.messages) yield m;
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

describe('computeSyncPlan (smoke)', () => {
  it('full-resync with no local state', () => {
    expect(computeSyncPlan({ lastSeenUid: 0 }, { uidValidity: '100', uidNext: 5 })).toMatchObject({
      kind: 'full-resync',
      reason: 'no-local-state',
    });
  });

  it('full-resync when uidValidity changes', () => {
    expect(
      computeSyncPlan({ uidValidity: '100', lastSeenUid: 4 }, { uidValidity: '200', uidNext: 5 }),
    ).toMatchObject({ kind: 'full-resync', reason: 'uidvalidity-changed' });
  });

  it('incremental for new UIDs, up-to-date otherwise', () => {
    expect(
      computeSyncPlan({ uidValidity: '100', lastSeenUid: 4 }, { uidValidity: '100', uidNext: 9 }),
    ).toMatchObject({ kind: 'incremental', fetchNewRange: '5:*' });
    expect(
      computeSyncPlan({ uidValidity: '100', lastSeenUid: 4 }, { uidValidity: '100', uidNext: 5 }),
    ).toMatchObject({ kind: 'up-to-date' });
  });
});

describe('MailboxSync against a fake client (smoke)', () => {
  it('applies a full resync, then reports up-to-date', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const client = new FakeImapClient(STATE, [msg(1, '<a@x>'), msg(2, '<b@x>')]);
    const sync = new MailboxSync(client, cache, {
      mailboxAddress: 'j.mikes@me.com',
      folderPath: 'INBOX',
    });

    const first = await sync.syncOnce();
    expect(first.plan.kind).toBe('full-resync');
    expect(first.fetched).toBe(2);
    expect(first.lastSeenUid).toBe(2);

    const second = await sync.syncOnce();
    expect(second.plan.kind).toBe('up-to-date');
    expect(second.fetched).toBe(0);
    cache.close();
  });

  it('invalidates and refetches on a uidValidity change', async () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const opts = { mailboxAddress: 'j.mikes@me.com', folderPath: 'INBOX' };

    await new MailboxSync(new FakeImapClient(STATE, [msg(1, '<a@x>')]), cache, opts).syncOnce();

    const changed: ImapMailboxState = { ...STATE, uidValidity: 999n };
    const result = await new MailboxSync(
      new FakeImapClient(changed, [msg(1, '<a@x>'), msg(2, '<b@x>')]),
      cache,
      opts,
    ).syncOnce();

    expect(result.invalidated).toBe(true);
    expect(result.plan.kind).toBe('full-resync');
    const folder = cache.getFolder('j.mikes@me.com', 'INBOX');
    expect(folder?.uid_validity).toBe('999');
    cache.close();
  });
});

describe('backoff (smoke)', () => {
  it('grows, caps, and stays within the jittered band', () => {
    const opts = { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0 };
    expect(backoffDelay(0, opts, () => 0)).toBe(100);
    expect(backoffDelay(2, opts, () => 0)).toBe(400);
    expect(backoffDelay(10, opts, () => 0)).toBe(1000); // capped
  });
});

describe('ResilientImapConnection (smoke)', () => {
  it('reconnects after a drop using injected timers (own reconnect)', async () => {
    const built: FakeConnClient[] = [];
    const scheduled: Array<() => void> = [];
    const connection = new ResilientImapConnection({
      clientFactory: () => {
        const client = new FakeConnClient();
        built.push(client);
        return client;
      },
      timers: {
        setTimeout: (callback) => {
          scheduled.push(callback);
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
      rng: () => 0,
      backoff: { baseMs: 1 },
    });

    await connection.start();
    expect(built).toHaveLength(1);

    built[0]?.emitClose(); // simulate ImapFlow's 'close' (it does NOT auto-reconnect)
    expect(scheduled).toHaveLength(1); // a reconnect was scheduled with backoff

    scheduled[0]?.(); // fire the backoff timer
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(built).toHaveLength(2); // a fresh client was created
    connection.stop();
  });
});

class FakeConnClient implements ImapClient {
  private closeListeners: Array<() => void> = [];
  connected = false;
  async connect(): Promise<void> {
    this.connected = true;
  }
  async logout(): Promise<void> {
    this.connected = false;
  }
  close(): void {
    this.connected = false;
  }
  async list(): Promise<readonly ImapFolderInfo[]> {
    return [];
  }
  async openMailbox(): Promise<ImapMailboxState> {
    return STATE;
  }
  async *fetchByUid(): AsyncIterable<ImapFetchedMessage> {
    for (const message of [] as ImapFetchedMessage[]) yield message;
  }
  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }
  onError(): Unsubscribe {
    return () => undefined;
  }
  onExists(): Unsubscribe {
    return () => undefined;
  }
  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}
