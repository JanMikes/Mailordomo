/**
 * Disposable index-DB schema (better-sqlite3 + FTS5).
 *
 * This DB is a MIRROR of IMAP truth — never a writable replica, never two-way synced (Golden rule
 * #2). It can be dropped and rebuilt at any time. Keys mirror the IMAP reality:
 *  - `folders` are unique per (mailbox_address, path); each carries the IMAP sync cursor
 *    (`uid_validity`, `uid_next`, `highest_modseq`, `last_seen_uid`).
 *  - `messages` are unique per (folder_id, uid); `uid_validity` is denormalized onto the row so the
 *    full (mailbox, uidValidity, uid) cache key is present, and a `message_id` index supports
 *    Message-ID lookups for threading.
 *  - `attachments` store content-hash + PATH (never the bytes), deduped per (message, hash).
 *  - `messages_fts` is a standalone FTS5 table indexing subject/sender/snippet/body for search.
 *    Body text is indexed here for LOCAL search only; it never leaves the machine (Golden rule #3).
 */
export const CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS folders (
  id              INTEGER PRIMARY KEY,
  mailbox_address TEXT    NOT NULL,
  path            TEXT    NOT NULL,
  special_use     TEXT,
  uid_validity    TEXT    NOT NULL,
  uid_next        INTEGER,
  highest_modseq  TEXT,
  last_seen_uid   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (mailbox_address, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY,
  folder_id      INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid            INTEGER NOT NULL,
  uid_validity   TEXT    NOT NULL,
  message_id     TEXT,
  in_reply_to    TEXT,
  references_json TEXT,
  thread_root_id TEXT,
  subject        TEXT,
  sender         TEXT,
  snippet        TEXT,
  internal_date  TEXT,
  size           INTEGER,
  flags_json     TEXT,
  eml_path       TEXT,
  UNIQUE (folder_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_message_id  ON messages (message_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages (thread_root_id);
CREATE INDEX IF NOT EXISTS idx_messages_folder      ON messages (folder_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  content_hash TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  UNIQUE (message_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments (content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
  subject,
  sender,
  snippet,
  body,
  tokenize = 'unicode61'
);
`;

/** Names of every object this schema creates — used by the drop-and-rebuild path. */
export const CACHE_TABLES = ['messages_fts', 'attachments', 'messages', 'folders'] as const;
