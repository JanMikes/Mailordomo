/**
 * Phase 4.5 · Test 2 — END-TO-END CACHE REBUILD-FROM-EMPTY (DoD a).
 *
 * Intent (PLAN.md §7 Phase 4.5 "a real cache rebuild-from-empty runs end-to-end ... and the app
 * comes back consistent"; Golden rule #2: the local cache is a DISPOSABLE, REBUILDABLE mirror —
 * never a second writable store): sync a {@link MessageCache} from a FAKE ImapClient via
 * {@link MailboxSync} (a few messages, real `.eml` blobs on disk), push the corresponding THREAD
 * metadata to the REAL server via the REAL {@link MetadataClient}, and snapshot the resulting state
 * (messages cached, FTS search, the /api/threads list, the server's thread row). Then
 * `cache.rebuildFromEmpty()` → assert it is empty. Then RE-SYNC from the same fake IMAP and RE-FETCH
 * the metadata via the client → assert both the cache AND the server round-trip come back CONSISTENT
 * with the pre-wipe snapshot. That equivalence is the proof the cache holds nothing the IMAP truth +
 * metadata service cannot regenerate.
 *
 * The fake IMAP surface is adapted from the Phase 3 `imap/sync-delta.test.ts` FakeImapClient — no
 * live mailbox, per PLAN.md §5.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageCache } from '../cache';
import type { MessageRow } from '../cache';
import { listCachedThreads } from '../api/threads-view';
import type { ThreadListItem } from '../api/threads-view';
import { MailboxSync } from '../imap/mailbox-sync';
import type {
  ImapClient,
  ImapFetchQuery,
  ImapFetchedMessage,
  ImapFolderInfo,
  ImapMailboxState,
} from '../imap/types';
import type { MetadataClient } from '../metadata-client';
import type { Thread, UpsertThreadRequest } from '@mailordomo/shared';
import { PROJECT_A, startInProcessServer, type InProcessServer } from './harness';

const MAILBOX = 'jan@acme.com';
const FOLDER = 'INBOX';
const UID_VALIDITY = 100n;

/** The fixed corpus the fake mailbox serves — stable across both syncs (IMAP is the "truth"). */
interface Seed {
  readonly uid: number;
  readonly messageId: string;
  readonly subject: string;
  readonly snippet: string;
  readonly sender: string;
  readonly body: string;
}

const SEEDS: readonly Seed[] = [
  {
    uid: 1,
    messageId: '<invoice@acme.com>',
    subject: 'Invoice 4291 attached',
    snippet: 'Please find the invoice attached.',
    sender: 'Billing <billing@acme.com>',
    body: 'Please find invoice 4291 attached. Payment is due in 30 days.',
  },
  {
    uid: 2,
    messageId: '<standup@acme.com>',
    subject: 'Standup notes Tuesday',
    snippet: 'Notes from the Tuesday standup.',
    sender: 'Petr <petr@acme.com>',
    body: 'Standup notes: shipped the sync engine, blocked on the metadata token.',
  },
  {
    uid: 3,
    messageId: '<welcome@acme.com>',
    subject: 'Welcome aboard',
    snippet: 'Glad to have you on the team.',
    sender: 'Lumír <lumir@acme.com>',
    body: 'Welcome aboard! Reach out any time with onboarding questions.',
  },
];

function seedToFetched(seed: Seed): ImapFetchedMessage {
  return {
    uid: seed.uid,
    flags: new Set(['\\Seen']),
    internalDate: new Date(`2026-06-0${seed.uid}T09:00:00.000Z`),
    size: 500 + seed.uid,
    envelope: {
      messageId: seed.messageId,
      subject: seed.subject,
      from: [parseSender(seed.sender)],
    },
    references: [],
    // Raw bytes → exercises the on-disk `.eml` store (blobDir) so the wipe has something to wipe.
    source: Buffer.from(`From: ${seed.sender}\r\nSubject: ${seed.subject}\r\n\r\n${seed.body}`),
  };
}

function parseSender(formatted: string): { name: string; address: string } {
  const match = /^(.*) <(.*)>$/.exec(formatted);
  return match ? { name: match[1] ?? '', address: match[2] ?? '' } : { name: '', address: '' };
}

/**
 * A fixed FAKE IMAP surface serving {@link SEEDS}, adapted from the Phase 3 sync-delta FakeImapClient.
 * Read-only; the engine only ever WRITES to the cache. Two syncs against it return the same corpus —
 * that stability is exactly the IMAP "truth" the rebuild re-derives from.
 */
class FixedFakeImapClient implements ImapClient {
  private readonly state: ImapMailboxState = {
    path: FOLDER,
    uidValidity: UID_VALIDITY,
    uidNext: SEEDS.length + 1,
    highestModseq: undefined,
    exists: SEEDS.length,
    readOnly: true,
  };

  async connect(): Promise<void> {}
  async logout(): Promise<void> {}
  close(): void {}
  async list(): Promise<readonly ImapFolderInfo[]> {
    return [{ path: FOLDER, flags: new Set<string>() }];
  }
  async openMailbox(): Promise<ImapMailboxState> {
    return this.state;
  }
  async *fetchByUid(_range: string, _query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    for (const seed of SEEDS) yield seedToFetched(seed);
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

/** Normalize a cache row to the load-bearing, rebuild-stable fields (drops the volatile row id). */
function envelopeOf(row: MessageRow): Record<string, unknown> {
  return {
    uid: row.uid,
    uid_validity: row.uid_validity,
    message_id: row.message_id,
    subject: row.subject,
    sender: row.sender,
    snippet: row.snippet,
    internal_date: row.internal_date,
    flags_json: row.flags_json,
  };
}

function cachedEnvelopes(cache: MessageCache): Record<string, unknown>[] {
  const folder = cache.getFolder(MAILBOX, FOLDER);
  if (!folder) return [];
  return cache
    .messagesInFolder(folder.id)
    .map(envelopeOf)
    .sort((a, b) => Number(a['uid']) - Number(b['uid']));
}

/** Push the cached envelopes as THREAD metadata to the server (the metadata side of the rebuild). */
async function pushThreadMetadata(cache: MessageCache, client: MetadataClient): Promise<void> {
  const folder = cache.getFolder(MAILBOX, FOLDER);
  if (!folder) throw new Error('expected the INBOX folder to be cached');
  for (const row of cache.messagesInFolder(folder.id)) {
    const req: UpsertThreadRequest = {
      project_id: PROJECT_A.id,
      mailbox_address: MAILBOX,
      root_message_id: row.message_id ?? `<row-${row.id}@local>`,
      subject: row.subject ?? '',
      snippet: row.snippet ?? '',
      sender: row.sender ?? '',
      last_message_at: row.internal_date,
    };
    await client.upsertThread(req);
  }
}

/** Server threads, normalized + sorted by root message id, with the volatile id/updated_at dropped. */
function serverThreadShape(threads: readonly Thread[]): Record<string, unknown>[] {
  return [...threads]
    .map((t) => ({
      project_id: t.project_id,
      mailbox_address: t.mailbox_address,
      root_message_id: t.root_message_id,
      subject: t.subject,
      snippet: t.snippet,
      sender: t.sender,
      last_message_at: t.last_message_at,
    }))
    .sort((a, b) => String(a.root_message_id).localeCompare(String(b.root_message_id)));
}

/** The /api/threads list shape (drops the synthetic threadKey, which is row-id-dependent). */
function threadListShape(items: readonly ThreadListItem[]): Record<string, unknown>[] {
  return items
    .map((t) => ({
      subject: t.subject,
      snippet: t.snippet,
      sender: t.sender,
      lastMessageAt: t.lastMessageAt,
      messageCount: t.messageCount,
    }))
    .sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
}

describe('Phase 4.5 cache rebuild-from-empty — end-to-end, cache stays a disposable mirror', () => {
  let dir: string;
  let cache: MessageCache;
  let server: InProcessServer;
  let client: MetadataClient;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mailordomo-rebuild-'));
    cache = MessageCache.open({
      dbPath: path.join(dir, 'cache.db'),
      blobDir: path.join(dir, 'blobs'),
    });
    server = startInProcessServer(PROJECT_A);
    client = server.client(PROJECT_A);
  });

  afterEach(() => {
    cache.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function syncFromFakeImap(): Promise<void> {
    const sync = new MailboxSync(new FixedFakeImapClient(), cache, {
      mailboxAddress: MAILBOX,
      folderPath: FOLDER,
    });
    const result = await sync.syncOnce();
    expect(result.fetched).toBe(SEEDS.length);
  }

  it('sync → snapshot → rebuildFromEmpty (asserts empty) → re-sync + re-fetch → consistent', async () => {
    // --- 1. Populate the cache from the fake IMAP truth, and the server from the cache. ---
    await syncFromFakeImap();
    await pushThreadMetadata(cache, client);

    // --- 2. Snapshot the PRE-WIPE state across all three observable surfaces. ---
    const beforeEnvelopes = cachedEnvelopes(cache);
    expect(beforeEnvelopes).toHaveLength(SEEDS.length);

    // The sync path indexes the SANCTIONED envelope fields (subject/sender/snippet) into FTS — body
    // text is NOT extracted through MailboxSync in Phase 3, so we search on indexed terms.
    const beforeSearch = cache.search('invoice').map((r) => r.message_id);
    expect(beforeSearch).toContain('<invoice@acme.com>'); // matches subject + snippet
    const beforeSnippetHit = cache.search('standup').map((r) => r.message_id);
    expect(beforeSnippetHit).toContain('<standup@acme.com>'); // matches subject "Standup notes ..."

    const beforeList = threadListShape(listCachedThreads(cache));
    expect(beforeList).toHaveLength(SEEDS.length);

    const beforeServer = serverThreadShape(await client.listThreads());
    expect(beforeServer).toHaveLength(SEEDS.length);

    // A representative `.eml` blob exists on disk before the wipe.
    const folderId = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    const emlBefore = cache.getMessageByUid(folderId, 1)?.eml_path ?? '';
    expect(existsSync(emlBefore)).toBe(true);

    // --- 3. Rebuild from empty: the cache (+ its on-disk store) is wiped clean. ---
    cache.rebuildFromEmpty();

    expect(cache.allFolders()).toEqual([]);
    expect(cachedEnvelopes(cache)).toEqual([]);
    expect(listCachedThreads(cache)).toEqual([]);
    expect(cache.search('invoice')).toEqual([]); // FTS wiped too
    expect(existsSync(emlBefore)).toBe(false); // the on-disk `.eml` is gone

    // The server (the metadata truth) is untouched by a LOCAL cache wipe — no two-way sync.
    expect(await client.listThreads()).toHaveLength(SEEDS.length);

    // --- 4. Re-derive: re-sync from the SAME fake IMAP, re-fetch metadata via the client. ---
    await syncFromFakeImap();
    const afterMetadata = serverThreadShape(await client.listThreads());

    // --- 5. The rebuilt state is CONSISTENT with the pre-wipe snapshot. ---
    expect(cachedEnvelopes(cache)).toEqual(beforeEnvelopes); // same messages cached
    expect(threadListShape(listCachedThreads(cache))).toEqual(beforeList); // same /api/threads view
    expect(cache.search('invoice').map((r) => r.message_id)).toEqual(beforeSearch); // same FTS
    expect(cache.search('standup').map((r) => r.message_id)).toEqual(beforeSnippetHit);
    expect(afterMetadata).toEqual(beforeServer); // same metadata from the server (idempotent upsert)

    // A fresh `.eml` blob is back on disk (rebuilt, not resurrected from a stale path).
    const folderIdAfter = cache.getFolder(MAILBOX, FOLDER)?.id ?? -1;
    const emlAfter = cache.getMessageByUid(folderIdAfter, 1)?.eml_path ?? '';
    expect(existsSync(emlAfter)).toBe(true);
  });
});
