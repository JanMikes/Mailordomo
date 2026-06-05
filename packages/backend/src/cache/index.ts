/**
 * Disposable local cache: better-sqlite3 + FTS5 index DB (`cache.ts` / `schema.ts`) plus the
 * on-disk raw `.eml` + content-addressed attachment store (`storage.ts`). A rebuildable MIRROR of
 * IMAP truth — never a two-way sync.
 */
export * from './schema';
export * from './storage';
export * from './cache';
