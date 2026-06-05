/**
 * The file-backed {@link DraftStore} — local-only draft persistence at
 * `$MAILORDOMO_CONFIG_DIR/drafts.db` (PLAN.md §7 Phase 7b, decision D31).
 *
 * WHY ITS OWN better-sqlite3 DB (not the disposable message cache): draft bodies + refine transcripts
 * are NOT rebuildable from IMAP or the metadata service, so they must NOT live in the cache (which is
 * a disposable mirror, wiped + rebuilt at will). They are also NOT server state (golden rules #2 +
 * #3 — never synced, body never leaves). So they get a dedicated DB under the LOCAL app config dir,
 * alongside `settings.json`, kept separate from `CACHE_DB_PATH`.
 *
 * Keyed by `thread_id`. `saveDraft` bumps `version` (first draft = 1; each refine increments). The
 * refine transcript is stored as a JSON column. The schema is created on open (idempotent).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { resolveConfigDir } from '../settings';
import type { DraftStore, LocalDraft, RefineTurn, SaveDraftInput } from './types';

/** The drafts DB filename within the LOCAL config dir. */
export const DRAFTS_DB_FILE_NAME = 'drafts.db';

/**
 * Resolve the drafts DB path: `$MAILORDOMO_CONFIG_DIR/drafts.db` (default `~/.mailordomo/drafts.db`).
 * Reuses the settings store's config-dir logic so drafts + settings share one local config home.
 */
export function resolveDraftsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigDir(env), DRAFTS_DB_FILE_NAME);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS drafts (
  thread_id       TEXT PRIMARY KEY,
  body            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  model           TEXT NOT NULL,
  author          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  transcript_json TEXT NOT NULL
);
`;

interface DraftRow {
  readonly thread_id: string;
  readonly body: string;
  readonly version: number;
  readonly model: string;
  readonly author: string;
  readonly created_at: string;
  readonly transcript_json: string;
}

function rowToDraft(row: DraftRow): LocalDraft {
  return {
    threadId: row.thread_id,
    body: row.body,
    version: row.version,
    model: row.model,
    author: row.author,
    createdAt: row.created_at,
    transcript: JSON.parse(row.transcript_json) as RefineTurn[],
  };
}

/**
 * A file-backed {@link DraftStore} at `dbPath` (the full path to `drafts.db`, or `:memory:`). The
 * runnable entry resolves the path with {@link resolveDraftsDbPath}; tests may pass `:memory:` or an
 * explicit temp path.
 */
export function createFileDraftStore(dbPath: string): DraftStore {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);

  const selectStmt = db.prepare('SELECT * FROM drafts WHERE thread_id = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO drafts (thread_id, body, version, model, author, created_at, transcript_json)
       VALUES (@thread_id, @body, @version, @model, @author, @created_at, @transcript_json)
     ON CONFLICT (thread_id) DO UPDATE SET
       body            = excluded.body,
       version         = excluded.version,
       model           = excluded.model,
       author          = excluded.author,
       created_at      = excluded.created_at,
       transcript_json = excluded.transcript_json`,
  );
  const deleteStmt = db.prepare('DELETE FROM drafts WHERE thread_id = ?');

  function getDraft(threadId: string): LocalDraft | undefined {
    const row = selectStmt.get(threadId) as DraftRow | undefined;
    return row === undefined ? undefined : rowToDraft(row);
  }

  function saveDraft(threadId: string, input: SaveDraftInput): LocalDraft {
    const current = selectStmt.get(threadId) as DraftRow | undefined;
    const draft: LocalDraft = {
      threadId,
      body: input.body,
      version: (current?.version ?? 0) + 1,
      model: input.model,
      author: input.author,
      createdAt: input.createdAt ?? new Date().toISOString(),
      transcript: [...input.transcript],
    };
    upsertStmt.run({
      thread_id: draft.threadId,
      body: draft.body,
      version: draft.version,
      model: draft.model,
      author: draft.author,
      created_at: draft.createdAt,
      transcript_json: JSON.stringify(draft.transcript),
    });
    return draft;
  }

  function clearDraft(threadId: string): void {
    deleteStmt.run(threadId);
  }

  return { getDraft, saveDraft, clearDraft };
}
