-- Mailordomo metadata service — initial schema (Phase 2).
--
-- Plain SQL, applied idempotently by the tiny migrator (src/db/migrate.ts). Field names mirror the
-- shared zod entities in @mailordomo/shared (PROJECT.md §5) verbatim (snake_case).
--
-- PRIVACY (Golden rule #3): there are NO email-body / draft-body / .eml / attachment columns. The
-- only large-text fields are the two sanctioned exceptions: notes.body (a USER note) and
-- tone_files.content (DERIVED tone memory). Draft rows carry metadata only — never body text.

-- Projects — the auth/pairing unit. token_hash is a sha256 hash of the shared secret, never plaintext.
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL
);

-- Threads — carries the sanctioned shared-digest fields (subject / snippet / sender). Upserted by
-- (project_id, root_message_id).
CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mailbox_address TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  subject         TEXT NOT NULL,
  snippet         TEXT NOT NULL,
  sender          TEXT NOT NULL,
  last_message_at TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE (project_id, root_message_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads (project_id);

-- Tasks — the work item attached to a thread.
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,
  deadline     TEXT,
  follow_up_at TEXT,
  importance   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks (thread_id);

-- Task transitions — actor-attributed state changes ("from"/"to" are SQL keywords, hence quoted).
CREATE TABLE IF NOT EXISTS task_transitions (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "from"  TEXT NOT NULL,
  "to"    TEXT NOT NULL,
  actor   TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions (task_id);

-- Promises — the 3-way tracker. due_at is the RESOLVED absolute deadline; due_raw the original
-- natural-language deadline the Phase 5 reconciler resolves against.
CREATE TABLE IF NOT EXISTS promises (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,
  text       TEXT NOT NULL,
  due_at     TEXT,
  due_raw    TEXT,
  status     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promises_thread ON promises (thread_id);

-- Notes — a USER-written per-thread note. `body` here is the user's own text (sanctioned), not email.
CREATE TABLE IF NOT EXISTS notes (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author    TEXT NOT NULL,
  body      TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_thread ON notes (thread_id);

-- Repo pointers — SHARED repo identity only (name + git_url). The machine-local clone path never
-- crosses to the server (decision D13).
CREATE TABLE IF NOT EXISTS repo_pointers (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  git_url    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repos_project ON repo_pointers (project_id);

-- Draft metadata — METADATA ONLY (model / author / version / timestamp). The draft body stays local.
CREATE TABLE IF NOT EXISTS draft_meta (
  id        TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  model     TEXT NOT NULL,
  author    TEXT NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_thread ON draft_meta (thread_id);

-- Locks — the Jan/Simona double-handling guard. One lock per thread; expires_at implements timeout.
CREATE TABLE IF NOT EXISTS locks (
  thread_id  TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  locked_by  TEXT NOT NULL,
  locked_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Tone files — synced tone memory. content is the sanctioned derived-memory field; the file
-- identity (and LWW key) is (project_id, scope, path).
CREATE TABLE IF NOT EXISTS tone_files (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  path         TEXT NOT NULL,
  content      TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, scope, path)
);

-- Learning changelog — silent, revertable. reverted_at NULL = still applied; set = reverted.
CREATE TABLE IF NOT EXISTS learning_entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  reverted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_project ON learning_entries (project_id);
