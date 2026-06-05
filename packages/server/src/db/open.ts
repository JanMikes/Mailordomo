import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** The concrete better-sqlite3 database handle type, re-exported so callers don't import the lib. */
export type Db = Database.Database;

/** In-memory database path (used by tests for a throwaway, fully-migrated DB). */
export const IN_MEMORY_DB = ':memory:';

/**
 * Open a better-sqlite3 database in WAL mode (PROJECT.md §12). For a file path the parent directory
 * is created if missing. WAL improves concurrent read/write behavior; foreign keys are enabled so
 * the schema's referential integrity (e.g. a lock must reference an existing thread) is enforced.
 */
export function openDatabase(path: string): Db {
  if (path !== IN_MEMORY_DB) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
