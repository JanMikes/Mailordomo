import { describe, expect, it } from 'vitest';
import { CacheStorage, MessageCache, contentHash } from './index';

/** Smoke coverage for the disposable cache (DB-only, in-memory). */

function seedFolder(cache: MessageCache, uidValidity: string) {
  return cache.upsertFolderMeta({
    mailboxAddress: 'j.mikes@me.com',
    path: 'INBOX',
    uidValidity,
    uidNext: 10,
  });
}

describe('MessageCache (smoke)', () => {
  it('upserts, full-text searches, and looks up by Message-ID', () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const folder = seedFolder(cache, '111');
    cache.upsertMessage({
      folderId: folder.id,
      uid: 5,
      uidValidity: '111',
      messageId: '<a@x>',
      subject: 'Invoice March',
      sender: 'Acme <billing@acme.com>',
      bodyText: 'please pay the invoice',
    });

    expect(cache.search('invoice').map((m) => m.uid)).toEqual([5]);
    expect(cache.getMessagesByMessageId('<a@x>')).toHaveLength(1);
    cache.close();
  });

  it('advances the sync cursor monotonically', () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const folder = seedFolder(cache, '111');
    cache.setSyncCursor(folder.id, 5);
    cache.setSyncCursor(folder.id, 3); // lower → ignored
    expect(cache.getFolderById(folder.id)?.last_seen_uid).toBe(5);
    cache.close();
  });

  it('invalidates a folder slice (rebuildable mirror)', () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const folder = seedFolder(cache, '111');
    cache.upsertMessage({ folderId: folder.id, uid: 1, uidValidity: '111', subject: 'hi' });
    cache.setSyncCursor(folder.id, 1);
    cache.invalidateFolder(folder.id);
    expect(cache.messagesInFolder(folder.id)).toHaveLength(0);
    expect(cache.getFolderById(folder.id)?.last_seen_uid).toBe(0);
    cache.close();
  });

  it('rebuilds from empty', () => {
    const cache = MessageCache.open({ dbPath: ':memory:' });
    const folder = seedFolder(cache, '111');
    cache.upsertMessage({ folderId: folder.id, uid: 1, uidValidity: '111', subject: 'hi' });
    cache.rebuildFromEmpty();
    expect(cache.allFolders()).toHaveLength(0);
    // schema is usable again after the rebuild
    const refreshed = seedFolder(cache, '222');
    expect(refreshed.uid_validity).toBe('222');
    cache.close();
  });
});

describe('CacheStorage (smoke)', () => {
  it('content-addresses and dedups blobs', () => {
    const root = `/tmp/mailordomo-cache-test-${process.pid}-${Date.now()}`;
    const storage = new CacheStorage(root);
    storage.init();
    const buffer = Buffer.from('attachment-bytes');
    const first = storage.storeBlob(buffer);
    const second = storage.storeBlob(buffer);
    expect(first.hash).toBe(contentHash(buffer));
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    storage.wipeAll();
  });
});
