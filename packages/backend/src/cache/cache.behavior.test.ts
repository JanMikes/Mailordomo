import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageCache } from './cache';

/**
 * Supporting suite for the disposable local cache (PROJECT.md §3/§5): FTS5 search, the
 * (mailbox,uidValidity,uid) keying + Message-ID index, rebuild-from-empty (DB + on-disk store), and
 * the Golden-rule-#2 invariant that it is a ONE-WAY mirror (no cache → IMAP write path). Uses temp
 * dirs and cleans up; no real network.
 */

let dir: string;
let cache: MessageCache;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mailordomo-cache-'));
  cache = MessageCache.open({
    dbPath: path.join(dir, 'cache.db'),
    blobDir: path.join(dir, 'blobs'),
  });
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedFolder(uidValidity = '100') {
  return cache.upsertFolderMeta({
    mailboxAddress: 'j.mikes@me.com',
    path: 'INBOX',
    uidValidity,
    uidNext: 10,
  });
}

describe('FTS5 search — an upsert becomes findable across subject/sender/snippet/body', () => {
  it('matches each indexed column, supports phrases + boolean, and excludes non-matches', () => {
    const folder = seedFolder();
    cache.upsertMessage({
      folderId: folder.id,
      uid: 5,
      uidValidity: '100',
      messageId: '<a@x>',
      subject: 'Quarterly Invoice',
      sender: 'Acme <billing@acme.com>',
      snippet: 'amount due soon',
      bodyText: 'please remit payment by Friday',
    });

    expect(cache.search('invoice').map((m) => m.uid)).toEqual([5]); // subject
    expect(cache.search('acme').map((m) => m.uid)).toEqual([5]); // sender
    expect(cache.search('payment').map((m) => m.uid)).toEqual([5]); // body
    expect(cache.search('"amount due"').map((m) => m.uid)).toEqual([5]); // snippet phrase
    expect(cache.search('invoice AND payment')).toHaveLength(1);
    expect(cache.search('invoice AND nonexistent')).toHaveLength(0);
    expect(cache.search('unrelated')).toHaveLength(0);
  });

  it('keeps the FTS row in lockstep on re-upsert (no stale index)', () => {
    const folder = seedFolder();
    cache.upsertMessage({ folderId: folder.id, uid: 1, uidValidity: '100', subject: 'old foozle' });
    expect(cache.search('foozle')).toHaveLength(1);

    cache.upsertMessage({ folderId: folder.id, uid: 1, uidValidity: '100', subject: 'new barzle' });
    expect(cache.search('foozle')).toHaveLength(0); // stale term gone
    expect(cache.search('barzle').map((m) => m.uid)).toEqual([1]);
  });
});

describe('keying — (mailbox, uidValidity, uid) and the Message-ID index', () => {
  it('denormalizes uid_validity onto the row so the full cache key is present', () => {
    const folder = seedFolder('100');
    cache.upsertMessage({ folderId: folder.id, uid: 5, uidValidity: '100', messageId: '<a@x>' });
    expect(cache.getMessageByUid(folder.id, 5)?.uid_validity).toBe('100');
  });

  it('scopes uid by folder — the same uid in two mailboxes is two distinct rows', () => {
    const inbox = cache.upsertFolderMeta({
      mailboxAddress: 'a@x',
      path: 'INBOX',
      uidValidity: '1',
    });
    const other = cache.upsertFolderMeta({
      mailboxAddress: 'b@y',
      path: 'INBOX',
      uidValidity: '1',
    });
    cache.upsertMessage({ folderId: inbox.id, uid: 5, uidValidity: '1', subject: 'for a' });
    cache.upsertMessage({ folderId: other.id, uid: 5, uidValidity: '1', subject: 'for b' });

    expect(cache.getMessageByUid(inbox.id, 5)?.subject).toBe('for a');
    expect(cache.getMessageByUid(other.id, 5)?.subject).toBe('for b');
  });

  it('looks up every row sharing a Message-ID via the index', () => {
    const f1 = cache.upsertFolderMeta({ mailboxAddress: 'a@x', path: 'INBOX', uidValidity: '1' });
    const f2 = cache.upsertFolderMeta({ mailboxAddress: 'a@x', path: 'Archive', uidValidity: '1' });
    cache.upsertMessage({ folderId: f1.id, uid: 1, uidValidity: '1', messageId: '<dup@x>' });
    cache.upsertMessage({ folderId: f2.id, uid: 1, uidValidity: '1', messageId: '<dup@x>' });
    cache.upsertMessage({ folderId: f1.id, uid: 2, uidValidity: '1', messageId: '<solo@x>' });

    expect(cache.getMessagesByMessageId('<dup@x>')).toHaveLength(2);
    expect(cache.getMessagesByMessageId('<solo@x>')).toHaveLength(1);
    expect(cache.getMessagesByMessageId('<absent@x>')).toHaveLength(0);
  });
});

describe('sync cursor — monotonic and never silently rewound', () => {
  it('only ever advances last_seen_uid forward and COALESCEs the modseq', () => {
    const folder = seedFolder();
    cache.setSyncCursor(folder.id, 5, '100');
    cache.setSyncCursor(folder.id, 3, null); // lower uid ignored; null modseq keeps old
    expect(cache.getFolderById(folder.id)?.last_seen_uid).toBe(5);
    expect(cache.getFolderById(folder.id)?.highest_modseq).toBe('100');

    cache.setSyncCursor(folder.id, 8, '200');
    expect(cache.getFolderById(folder.id)?.last_seen_uid).toBe(8);
    expect(cache.getFolderById(folder.id)?.highest_modseq).toBe('200');
  });

  it('upsertFolderMeta refreshes metadata without rewinding the cursor', () => {
    const folder = seedFolder();
    cache.setSyncCursor(folder.id, 9);
    const refreshed = cache.upsertFolderMeta({
      mailboxAddress: 'j.mikes@me.com',
      path: 'INBOX',
      uidValidity: '100',
      uidNext: 42,
    });
    expect(refreshed.last_seen_uid).toBe(9);
  });
});

describe('invalidateFolder — wipes the slice (DB + disk) and resets the cursor', () => {
  it('deletes messages, drops the on-disk .eml, and zeroes the cursor', () => {
    const folder = seedFolder('100');
    const storage = cache.storage;
    expect(storage).not.toBeNull();
    const emlPath = storage!.storeEml('j.mikes@me.com', 'INBOX', '100', 1, Buffer.from('raw'));
    cache.upsertMessage({ folderId: folder.id, uid: 1, uidValidity: '100', emlPath });
    cache.setSyncCursor(folder.id, 1);
    expect(existsSync(emlPath)).toBe(true);

    cache.invalidateFolder(folder.id);

    expect(cache.messagesInFolder(folder.id)).toHaveLength(0);
    expect(cache.getFolderById(folder.id)?.last_seen_uid).toBe(0);
    expect(cache.getFolderById(folder.id)?.highest_modseq).toBeNull();
    expect(existsSync(emlPath)).toBe(false); // on-disk slice gone
  });
});

describe('rebuildFromEmpty — disposable mirror clears DB + disk, then works again', () => {
  it('wipes folders, messages, FTS and the on-disk store, and the schema is reusable', () => {
    const folder = seedFolder('100');
    const storage = cache.storage;
    expect(storage).not.toBeNull();
    const emlPath = storage!.storeEml('j.mikes@me.com', 'INBOX', '100', 1, Buffer.from('raw'));
    const blob = storage!.storeBlob(Buffer.from('attachment'));
    cache.upsertMessage({
      folderId: folder.id,
      uid: 1,
      uidValidity: '100',
      subject: 'findme',
      emlPath,
    });
    expect(cache.search('findme')).toHaveLength(1);
    expect(existsSync(emlPath)).toBe(true);
    expect(existsSync(blob.path)).toBe(true);

    cache.rebuildFromEmpty();

    expect(cache.allFolders()).toHaveLength(0);
    expect(cache.search('findme')).toHaveLength(0); // FTS recreated + empty
    expect(existsSync(emlPath)).toBe(false);
    expect(existsSync(blob.path)).toBe(false);

    // Schema is usable again after the rebuild (proves DROP+recreate, not just DELETE).
    const reseeded = seedFolder('222');
    cache.upsertMessage({ folderId: reseeded.id, uid: 1, uidValidity: '222', subject: 'again' });
    expect(reseeded.uid_validity).toBe('222');
    expect(cache.search('again')).toHaveLength(1);
  });
});

describe('Golden rule #2 — the cache is a ONE-WAY mirror', () => {
  it('exposes no method shaped like a write-back to IMAP / SMTP', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(cache) as object).filter(
      (name) => name !== 'constructor',
    );

    // Every public operation is a LOCAL read/write of the DB or on-disk store. There is no
    // append/send/upload/push path back to the server (that verb lives only on the separate
    // ImapAppendClient used by the manual send path).
    const writeBackShaped = methods.filter((name) =>
      /append|send|upload|push|transmit|smtp|imap|writeback|toserver/i.test(name),
    );
    expect(writeBackShaped).toEqual([]);
  });
});
