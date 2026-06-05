/**
 * The disposable local cache (PROJECT.md §3 / decision D18): a better-sqlite3 index DB with an
 * FTS5 full-text table, plus raw `.eml` + content-addressed attachments on disk (see `storage.ts`).
 *
 * INVARIANTS:
 *  - It is a MIRROR. Every write here originates from IMAP truth; nothing flows cache → IMAP. There
 *    is no merge/reconciliation logic anywhere (Golden rule #2).
 *  - It is REBUILDABLE FROM EMPTY: {@link MessageCache.rebuildFromEmpty} drops every table and wipes
 *    the on-disk store; a fresh sync (+ metadata fetch) repopulates it.
 *  - The cache key is (mailbox, uidValidity, uid). `uid_validity` is denormalized onto each message
 *    row, and a Message-ID index supports threading lookups.
 *  - A uidValidity change invalidates exactly that folder's slice (DB rows + on-disk `.eml`) and
 *    forces a resync — the cache being rebuildable is what makes that safe.
 */
import Database from 'better-sqlite3';
import { CACHE_SCHEMA_SQL, CACHE_TABLES } from './schema';
import { CacheStorage } from './storage';

type Db = Database.Database;

export interface FolderRow {
  readonly id: number;
  readonly mailbox_address: string;
  readonly path: string;
  readonly special_use: string | null;
  readonly uid_validity: string;
  readonly uid_next: number | null;
  readonly highest_modseq: string | null;
  readonly last_seen_uid: number;
}

export interface MessageRow {
  readonly id: number;
  readonly folder_id: number;
  readonly uid: number;
  readonly uid_validity: string;
  readonly message_id: string | null;
  readonly in_reply_to: string | null;
  readonly references_json: string | null;
  readonly thread_root_id: string | null;
  readonly subject: string | null;
  readonly sender: string | null;
  readonly snippet: string | null;
  readonly internal_date: string | null;
  readonly size: number | null;
  readonly flags_json: string | null;
  readonly eml_path: string | null;
}

export interface UpsertFolderInput {
  readonly mailboxAddress: string;
  readonly path: string;
  readonly specialUse?: string | null;
  readonly uidValidity: string | bigint;
  readonly uidNext?: number | null;
  readonly highestModseq?: string | bigint | null;
}

export interface UpsertMessageInput {
  readonly folderId: number;
  readonly uid: number;
  readonly uidValidity: string | bigint;
  readonly messageId?: string | null;
  readonly inReplyTo?: string | null;
  readonly references?: readonly string[] | null;
  readonly subject?: string | null;
  readonly sender?: string | null;
  readonly snippet?: string | null;
  readonly internalDate?: string | Date | null;
  readonly size?: number | null;
  readonly flags?: readonly string[] | null;
  readonly emlPath?: string | null;
  /** Plain-text body, indexed in FTS for LOCAL search only. Never leaves the machine. */
  readonly bodyText?: string | null;
}

export interface AttachmentInput {
  readonly filename?: string | null;
  readonly contentType?: string | null;
  readonly size?: number | null;
  readonly contentHash: string;
  readonly path: string;
}

export interface OpenCacheOptions {
  /** SQLite path, or `:memory:` for tests. */
  readonly dbPath: string;
  /** Root dir for `.eml` + attachment files. Omit to run DB-only (e.g. unit tests). */
  readonly blobDir?: string;
}

function toText(value: string | bigint | null | undefined): string | null {
  if (value == null) return null;
  return typeof value === 'bigint' ? value.toString() : value;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}

export class MessageCache {
  private readonly db: Db;
  readonly storage: CacheStorage | null;

  private constructor(db: Db, storage: CacheStorage | null) {
    this.db = db;
    this.storage = storage;
  }

  static open(options: OpenCacheOptions): MessageCache {
    const db = new Database(options.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const storage = options.blobDir ? new CacheStorage(options.blobDir) : null;
    storage?.init();
    const cache = new MessageCache(db, storage);
    cache.migrate();
    return cache;
  }

  /** Create the schema if absent. Safe to call repeatedly. */
  migrate(): void {
    this.db.exec(CACHE_SCHEMA_SQL);
  }

  /** Drop every table, then recreate. The DB half of rebuild-from-empty. */
  reset(): void {
    const drop = CACHE_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n');
    this.db.exec(drop);
    this.migrate();
  }

  /** Full rebuild-from-empty: drop the DB schema AND wipe the on-disk `.eml`/attachment store. */
  rebuildFromEmpty(): void {
    this.reset();
    this.storage?.wipeAll();
    this.storage?.init();
  }

  getFolder(mailboxAddress: string, folderPath: string): FolderRow | undefined {
    return this.db
      .prepare('SELECT * FROM folders WHERE mailbox_address = ? AND path = ?')
      .get(mailboxAddress, folderPath) as FolderRow | undefined;
  }

  getFolderById(id: number): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
  }

  allFolders(): FolderRow[] {
    return this.db
      .prepare('SELECT * FROM folders ORDER BY mailbox_address, path')
      .all() as FolderRow[];
  }

  /**
   * Insert or update a folder's metadata + sync cursor columns. NEVER touches `last_seen_uid` on an
   * existing row (the sync cursor is advanced only via {@link setSyncCursor} / {@link invalidateFolder}),
   * so changing folder metadata can't silently rewind the cursor.
   */
  upsertFolderMeta(input: UpsertFolderInput): FolderRow {
    const row = this.db
      .prepare(
        `INSERT INTO folders (mailbox_address, path, special_use, uid_validity, uid_next, highest_modseq, last_seen_uid)
         VALUES (@mailbox_address, @path, @special_use, @uid_validity, @uid_next, @highest_modseq, 0)
         ON CONFLICT (mailbox_address, path) DO UPDATE SET
           special_use    = COALESCE(excluded.special_use, folders.special_use),
           uid_validity   = excluded.uid_validity,
           uid_next       = excluded.uid_next,
           highest_modseq = excluded.highest_modseq
         RETURNING *`,
      )
      .get({
        mailbox_address: input.mailboxAddress,
        path: input.path,
        special_use: input.specialUse ?? null,
        uid_validity: toText(input.uidValidity),
        uid_next: input.uidNext ?? null,
        highest_modseq: toText(input.highestModseq),
      }) as FolderRow;
    return row;
  }

  /** Advance the sync cursor. `last_seen_uid` only ever moves forward (monotonic via MAX). */
  setSyncCursor(
    folderId: number,
    lastSeenUid: number,
    highestModseq?: string | bigint | null,
  ): void {
    this.db
      .prepare(
        `UPDATE folders
           SET last_seen_uid  = MAX(last_seen_uid, @last_seen_uid),
               highest_modseq = COALESCE(@highest_modseq, highest_modseq)
         WHERE id = @id`,
      )
      .run({ id: folderId, last_seen_uid: lastSeenUid, highest_modseq: toText(highestModseq) });
  }

  /**
   * Invalidate a folder after a uidValidity change (or any forced resync): delete its messages
   * (cascading attachments + FTS rows), wipe its on-disk `.eml`, and reset the sync cursor to 0 so
   * the next sync refetches from scratch. The cache being a disposable mirror is what makes this a
   * safe, lossless operation.
   */
  invalidateFolder(folderId: number): void {
    const folder = this.getFolderById(folderId);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id = ?)',
        )
        .run(folderId);
      this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId);
      this.db
        .prepare('UPDATE folders SET last_seen_uid = 0, highest_modseq = NULL WHERE id = ?')
        .run(folderId);
    });
    tx();
    if (folder && this.storage) {
      this.storage.wipeFolder(folder.mailbox_address, folder.path, folder.uid_validity);
    }
  }

  /** Insert or update a message by its (folder, uid) key, keeping the FTS row in lockstep. */
  upsertMessage(input: UpsertMessageInput): number {
    const tx = this.db.transaction((): number => {
      const result = this.db
        .prepare(
          `INSERT INTO messages
             (folder_id, uid, uid_validity, message_id, in_reply_to, references_json,
              subject, sender, snippet, internal_date, size, flags_json, eml_path)
           VALUES
             (@folder_id, @uid, @uid_validity, @message_id, @in_reply_to, @references_json,
              @subject, @sender, @snippet, @internal_date, @size, @flags_json, @eml_path)
           ON CONFLICT (folder_id, uid) DO UPDATE SET
             uid_validity    = excluded.uid_validity,
             message_id      = excluded.message_id,
             in_reply_to     = excluded.in_reply_to,
             references_json = excluded.references_json,
             subject         = excluded.subject,
             sender          = excluded.sender,
             snippet         = excluded.snippet,
             internal_date   = excluded.internal_date,
             size            = excluded.size,
             flags_json      = excluded.flags_json,
             eml_path        = COALESCE(excluded.eml_path, messages.eml_path)
           RETURNING id`,
        )
        .get({
          folder_id: input.folderId,
          uid: input.uid,
          uid_validity: toText(input.uidValidity),
          message_id: input.messageId ?? null,
          in_reply_to: input.inReplyTo ?? null,
          references_json: input.references ? JSON.stringify(input.references) : null,
          subject: input.subject ?? null,
          sender: input.sender ?? null,
          snippet: input.snippet ?? null,
          internal_date: toIsoOrNull(input.internalDate),
          size: input.size ?? null,
          flags_json: input.flags ? JSON.stringify(input.flags) : null,
          eml_path: input.emlPath ?? null,
        }) as { id: number };

      const rowid = result.id;
      this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(rowid);
      this.db
        .prepare(
          'INSERT INTO messages_fts (rowid, subject, sender, snippet, body) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          rowid,
          input.subject ?? '',
          input.sender ?? '',
          input.snippet ?? '',
          input.bodyText ?? '',
        );
      return rowid;
    });
    return tx();
  }

  /** Record an attachment by content hash (paths only, never bytes). Deduped per (message, hash). */
  addAttachment(messageRowId: number, attachment: AttachmentInput): void {
    this.db
      .prepare(
        `INSERT INTO attachments (message_id, filename, content_type, size, content_hash, path)
         VALUES (@message_id, @filename, @content_type, @size, @content_hash, @path)
         ON CONFLICT (message_id, content_hash) DO NOTHING`,
      )
      .run({
        message_id: messageRowId,
        filename: attachment.filename ?? null,
        content_type: attachment.contentType ?? null,
        size: attachment.size ?? null,
        content_hash: attachment.contentHash,
        path: attachment.path,
      });
  }

  getMessageByUid(folderId: number, uid: number): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE folder_id = ? AND uid = ?')
      .get(folderId, uid) as MessageRow | undefined;
  }

  getMessagesByMessageId(messageId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE message_id = ? ORDER BY id')
      .all(messageId) as MessageRow[];
  }

  messagesInFolder(folderId: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE folder_id = ? ORDER BY uid')
      .all(folderId) as MessageRow[];
  }

  setThreadRoot(messageRowId: number, threadRootId: string | null): void {
    this.db
      .prepare('UPDATE messages SET thread_root_id = ? WHERE id = ?')
      .run(threadRootId, messageRowId);
  }

  /**
   * Full-text search over subject/sender/snippet/body via FTS5, best-match first. `query` is FTS5
   * MATCH syntax (e.g. `invoice OR receipt`, `"exact phrase"`). Local-only; bodies never leave.
   */
  search(query: string, limit = 50): MessageRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM messages_fts f
           JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as MessageRow[];
  }

  close(): void {
    this.db.close();
  }
}
