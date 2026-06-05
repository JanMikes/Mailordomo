/**
 * better-sqlite3 implementation of {@link Repository} (PROJECT.md §12; PLAN.md §3).
 *
 * Synchronous by design: every multi-step mutation that must be atomic (task transitions, lock
 * acquire/refresh/release, tone-file LWW) runs inside a better-sqlite3 transaction, which gives
 * read-modify-write atomicity without async races. All client-supplied datetimes are normalized to
 * UTC `Z` form on the way in (`normalizeIso`) so stored ISO strings sort lexicographically by
 * instant — the digest's range queries and the lock-expiry comparison rely on this.
 *
 * PRIVACY (Golden rule #3): there is no body column anywhere except the two sanctioned fields
 * (`notes.body`, `tone_files.content`); the strict shared DTOs reject any body key before it
 * reaches here.
 */
import type {
  AcquireLockRequest,
  CreateDraftMetaRequest,
  CreateLearningEntryRequest,
  CreateNoteRequest,
  CreatePromiseRequest,
  CreateRepoPointerRequest,
  CreateTaskRequest,
  CreateTaskTransitionRequest,
  DigestDraftEntry,
  DigestMetadata,
  DigestMetadataRequest,
  DigestPromiseEntry,
  DigestThreadRef,
  DigestTransitionEntry,
  DraftMeta,
  Importance,
  LearningEntry,
  Lock,
  ModelAlias,
  Note,
  Project,
  PromiseDirection,
  PromiseRecord,
  PromiseStatus,
  PutToneFileRequest,
  PutToneFileResponse,
  RefreshLockRequest,
  ReleaseLockRequest,
  RepoPointer,
  Task,
  TaskState,
  TaskTransition,
  Thread,
  ToneFile,
  ToneScope,
  UpdatePromiseRequest,
  UpdateTaskRequest,
  UpsertThreadRequest,
} from '@mailordomo/shared';
import { INITIAL_TASK_STATE } from '@mailordomo/shared';
import type { AcquireResult, RefreshResult, Repository, TransitionResult } from './repository';
import type { Db } from '../db/open';
import { IN_MEMORY_DB, openDatabase } from '../db/open';
import { runMigrations } from '../db/migrate';
import { newId } from '../ids';
import { computeExpiry, isExpired, resolveTtlSeconds } from '../locks';

/* --------------------------- datetime normalization ---------------------------- */

/** Normalize a (validated) ISO datetime to canonical UTC `Z` form so string compares == instant. */
function normalizeIso(iso: string): string {
  return new Date(iso).toISOString();
}

function normalizeIsoNullable(iso: string | null | undefined): string | null {
  return iso === null || iso === undefined ? null : normalizeIso(iso);
}

/* --------------------------------- row shapes ---------------------------------- */
/* Rows are typed with the entity unions because all data enters via validated strict DTOs. */

interface ThreadRow {
  id: string;
  project_id: string;
  mailbox_address: string;
  root_message_id: string;
  subject: string;
  snippet: string;
  sender: string;
  last_message_at: string | null;
  updated_at: string;
}

interface TaskRow {
  id: string;
  thread_id: string;
  state: TaskState;
  deadline: string | null;
  follow_up_at: string | null;
  importance: Importance;
  updated_at: string;
}

interface TransitionRow {
  id: string;
  task_id: string;
  from: TaskState;
  to: TaskState;
  actor: string;
  at: string;
}

interface PromiseRow {
  id: string;
  thread_id: string;
  direction: PromiseDirection;
  text: string;
  due_at: string | null;
  due_raw: string | null;
  status: PromiseStatus;
  actor: string;
  created_at: string;
}

interface NoteRow {
  id: string;
  thread_id: string;
  author: string;
  body: string;
  at: string;
}

interface RepoRow {
  id: string;
  project_id: string;
  name: string;
  git_url: string;
}

interface DraftRow {
  id: string;
  thread_id: string;
  version: number;
  model: ModelAlias;
  author: string;
  at: string;
}

interface LockRow {
  thread_id: string;
  locked_by: string;
  locked_at: string;
  expires_at: string;
}

interface ToneRow {
  project_id: string;
  scope: ToneScope;
  path: string;
  content: string;
  version_hash: string;
  updated_by: string;
  updated_at: string;
}

interface LearningRow {
  id: string;
  project_id: string;
  scope: ToneScope;
  summary: string;
  applied_at: string;
  reverted_at: string | null;
}

/* ---------------------------------- mappers ------------------------------------ */

const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  project_id: r.project_id,
  mailbox_address: r.mailbox_address,
  root_message_id: r.root_message_id,
  subject: r.subject,
  snippet: r.snippet,
  sender: r.sender,
  last_message_at: r.last_message_at,
  updated_at: r.updated_at,
});

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  thread_id: r.thread_id,
  state: r.state,
  deadline: r.deadline,
  follow_up_at: r.follow_up_at,
  importance: r.importance,
  updated_at: r.updated_at,
});

const toTransition = (r: TransitionRow): TaskTransition => ({
  id: r.id,
  task_id: r.task_id,
  from: r.from,
  to: r.to,
  actor: r.actor,
  at: r.at,
});

const toPromise = (r: PromiseRow): PromiseRecord => ({
  id: r.id,
  thread_id: r.thread_id,
  direction: r.direction,
  text: r.text,
  due_at: r.due_at,
  due_raw: r.due_raw,
  status: r.status,
  actor: r.actor,
  created_at: r.created_at,
});

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  thread_id: r.thread_id,
  author: r.author,
  body: r.body,
  at: r.at,
});

const toRepo = (r: RepoRow): RepoPointer => ({
  id: r.id,
  project_id: r.project_id,
  name: r.name,
  git_url: r.git_url,
});

const toDraft = (r: DraftRow): DraftMeta => ({
  id: r.id,
  thread_id: r.thread_id,
  version: r.version,
  model: r.model,
  author: r.author,
  at: r.at,
});

const toLock = (r: LockRow): Lock => ({
  thread_id: r.thread_id,
  locked_by: r.locked_by,
  locked_at: r.locked_at,
  expires_at: r.expires_at,
});

const toToneFile = (r: ToneRow): ToneFile => ({
  project_id: r.project_id,
  scope: r.scope,
  path: r.path,
  content: r.content,
  version_hash: r.version_hash,
  updated_by: r.updated_by,
  updated_at: r.updated_at,
});

const toLearning = (r: LearningRow): LearningEntry => ({
  id: r.id,
  project_id: r.project_id,
  scope: r.scope,
  summary: r.summary,
  applied_at: r.applied_at,
  reverted_at: r.reverted_at,
});

/**
 * Deterministic last-write-wins: newer `updated_at` wins; ties broken by `version_hash` (strictly
 * greater). A re-push of the identical version (same updated_at AND hash) is therefore a no-op
 * (`accepted: false`) — nothing changed — rather than a redundant rewrite.
 */
function toneWriteWins(incoming: ToneFile, existing: ToneFile): boolean {
  const inc = Date.parse(incoming.updated_at);
  const cur = Date.parse(existing.updated_at);
  if (inc > cur) return true;
  if (inc < cur) return false;
  return incoming.version_hash > existing.version_hash;
}

/* -------------------------------- repository ----------------------------------- */

class SqliteRepository implements Repository {
  constructor(private readonly db: Db) {}

  /* projects / auth */
  getProjectById(id: string): Project | undefined {
    const row = this.db
      .prepare('SELECT id, name, token_hash FROM projects WHERE id = ?')
      .get(id) as Project | undefined;
    return row;
  }

  upsertProject(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, token_hash) VALUES (@id, @name, @token_hash)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash`,
      )
      .run(project);
  }

  /* threads */
  upsertThread(projectId: string, req: UpsertThreadRequest, now: string): Thread {
    const row = this.db
      .prepare(
        `INSERT INTO threads
           (id, project_id, mailbox_address, root_message_id, subject, snippet, sender,
            last_message_at, updated_at)
         VALUES
           (@id, @project_id, @mailbox_address, @root_message_id, @subject, @snippet, @sender,
            @last_message_at, @updated_at)
         ON CONFLICT(project_id, root_message_id) DO UPDATE SET
           mailbox_address = excluded.mailbox_address,
           subject         = excluded.subject,
           snippet         = excluded.snippet,
           sender          = excluded.sender,
           last_message_at = excluded.last_message_at,
           updated_at      = excluded.updated_at
         RETURNING *`,
      )
      .get({
        id: newId(),
        project_id: projectId,
        mailbox_address: req.mailbox_address,
        root_message_id: req.root_message_id,
        subject: req.subject,
        snippet: req.snippet,
        sender: req.sender,
        last_message_at: normalizeIsoNullable(req.last_message_at),
        updated_at: now,
      }) as ThreadRow;
    return toThread(row);
  }

  listThreads(projectId: string): Thread[] {
    const rows = this.db
      .prepare('SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as ThreadRow[];
    return rows.map(toThread);
  }

  getThread(projectId: string, threadId: string): Thread | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE id = ? AND project_id = ?')
      .get(threadId, projectId) as ThreadRow | undefined;
    return row === undefined ? undefined : toThread(row);
  }

  /* tasks & transitions */
  createTask(projectId: string, req: CreateTaskRequest, now: string): Task | undefined {
    if (this.getThread(projectId, req.thread_id) === undefined) return undefined;
    const task: Task = {
      id: newId(),
      thread_id: req.thread_id,
      state: req.state ?? INITIAL_TASK_STATE,
      deadline: normalizeIsoNullable(req.deadline),
      follow_up_at: normalizeIsoNullable(req.follow_up_at),
      importance: req.importance ?? 'normal',
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, thread_id, state, deadline, follow_up_at, importance, updated_at)
         VALUES (@id, @thread_id, @state, @deadline, @follow_up_at, @importance, @updated_at)`,
      )
      .run(task);
    return task;
  }

  listTasks(projectId: string, threadId?: string): Task[] {
    const rows = (
      threadId === undefined
        ? this.db
            .prepare(
              `SELECT t.* FROM tasks t JOIN threads th ON th.id = t.thread_id
               WHERE th.project_id = ? ORDER BY t.updated_at DESC`,
            )
            .all(projectId)
        : this.db
            .prepare(
              `SELECT t.* FROM tasks t JOIN threads th ON th.id = t.thread_id
               WHERE th.project_id = ? AND t.thread_id = ? ORDER BY t.updated_at DESC`,
            )
            .all(projectId, threadId)
    ) as TaskRow[];
    return rows.map(toTask);
  }

  getTask(projectId: string, taskId: string): Task | undefined {
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN threads th ON th.id = t.thread_id
         WHERE t.id = ? AND th.project_id = ?`,
      )
      .get(taskId, projectId) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  updateTask(
    projectId: string,
    taskId: string,
    req: UpdateTaskRequest,
    now: string,
  ): Task | undefined {
    const current = this.getTask(projectId, taskId);
    if (current === undefined) return undefined;
    const updated: Task = {
      ...current,
      deadline: req.deadline !== undefined ? normalizeIsoNullable(req.deadline) : current.deadline,
      follow_up_at:
        req.follow_up_at !== undefined
          ? normalizeIsoNullable(req.follow_up_at)
          : current.follow_up_at,
      importance: req.importance ?? current.importance,
      updated_at: now,
    };
    this.db
      .prepare(
        `UPDATE tasks SET deadline = @deadline, follow_up_at = @follow_up_at,
           importance = @importance, updated_at = @updated_at WHERE id = @id`,
      )
      .run(updated);
    return updated;
  }

  createTransition(
    projectId: string,
    taskId: string,
    req: CreateTaskTransitionRequest,
    now: string,
  ): TransitionResult {
    // NB: transition LEGALITY (the allowed-edge table) is enforced by the Phase 3 state machine,
    // not the wire DTO (PLAN.md §10 Phase 1 review). The server records any from→to and only
    // guards optimistic concurrency via `expected_from`.
    return this.db.transaction((): TransitionResult => {
      const task = this.getTask(projectId, taskId);
      if (task === undefined) return { ok: false, reason: 'not-found' };
      if (req.expected_from !== undefined && task.state !== req.expected_from) {
        return { ok: false, reason: 'stale', currentState: task.state };
      }
      const transition: TaskTransition = {
        id: newId(),
        task_id: taskId,
        from: task.state,
        to: req.to,
        actor: req.actor,
        at: now,
      };
      this.db
        .prepare(
          `INSERT INTO task_transitions (id, task_id, "from", "to", actor, at)
           VALUES (@id, @task_id, @from, @to, @actor, @at)`,
        )
        .run(transition);
      this.db
        .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
        .run(req.to, now, taskId);
      return { ok: true, transition, task: { ...task, state: req.to, updated_at: now } };
    })();
  }

  listTransitions(projectId: string, taskId: string): TaskTransition[] | undefined {
    if (this.getTask(projectId, taskId) === undefined) return undefined;
    const rows = this.db
      .prepare('SELECT * FROM task_transitions WHERE task_id = ? ORDER BY at ASC')
      .all(taskId) as TransitionRow[];
    return rows.map(toTransition);
  }

  /* promises */
  createPromise(
    projectId: string,
    req: CreatePromiseRequest,
    now: string,
  ): PromiseRecord | undefined {
    if (this.getThread(projectId, req.thread_id) === undefined) return undefined;
    const promise: PromiseRecord = {
      id: newId(),
      thread_id: req.thread_id,
      direction: req.direction,
      text: req.text,
      due_at: normalizeIsoNullable(req.due_at),
      due_raw: req.due_raw ?? null,
      status: req.status ?? 'open',
      actor: req.actor,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO promises
           (id, thread_id, direction, text, due_at, due_raw, status, actor, created_at)
         VALUES
           (@id, @thread_id, @direction, @text, @due_at, @due_raw, @status, @actor, @created_at)`,
      )
      .run(promise);
    return promise;
  }

  listPromises(projectId: string, threadId?: string): PromiseRecord[] {
    const rows = (
      threadId === undefined
        ? this.db
            .prepare(
              `SELECT p.* FROM promises p JOIN threads th ON th.id = p.thread_id
               WHERE th.project_id = ? ORDER BY p.created_at DESC`,
            )
            .all(projectId)
        : this.db
            .prepare(
              `SELECT p.* FROM promises p JOIN threads th ON th.id = p.thread_id
               WHERE th.project_id = ? AND p.thread_id = ? ORDER BY p.created_at DESC`,
            )
            .all(projectId, threadId)
    ) as PromiseRow[];
    return rows.map(toPromise);
  }

  updatePromise(
    projectId: string,
    promiseId: string,
    req: UpdatePromiseRequest,
  ): PromiseRecord | undefined {
    const current = this.getPromiseScoped(projectId, promiseId);
    if (current === undefined) return undefined;
    const updated: PromiseRecord = {
      ...current,
      direction: req.direction ?? current.direction,
      text: req.text ?? current.text,
      due_at: req.due_at !== undefined ? normalizeIsoNullable(req.due_at) : current.due_at,
      due_raw: req.due_raw !== undefined ? req.due_raw : current.due_raw,
      status: req.status ?? current.status,
      actor: req.actor ?? current.actor,
    };
    this.db
      .prepare(
        `UPDATE promises SET direction = @direction, text = @text, due_at = @due_at,
           due_raw = @due_raw, status = @status, actor = @actor WHERE id = @id`,
      )
      .run(updated);
    return updated;
  }

  private getPromiseScoped(projectId: string, promiseId: string): PromiseRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT p.* FROM promises p JOIN threads th ON th.id = p.thread_id
         WHERE p.id = ? AND th.project_id = ?`,
      )
      .get(promiseId, projectId) as PromiseRow | undefined;
    return row === undefined ? undefined : toPromise(row);
  }

  /* notes */
  createNote(projectId: string, req: CreateNoteRequest, now: string): Note | undefined {
    if (this.getThread(projectId, req.thread_id) === undefined) return undefined;
    const note: Note = {
      id: newId(),
      thread_id: req.thread_id,
      author: req.author,
      body: req.body,
      at: now,
    };
    this.db
      .prepare(
        `INSERT INTO notes (id, thread_id, author, body, at)
         VALUES (@id, @thread_id, @author, @body, @at)`,
      )
      .run(note);
    return note;
  }

  listNotes(projectId: string, threadId?: string): Note[] {
    const rows = (
      threadId === undefined
        ? this.db
            .prepare(
              `SELECT n.* FROM notes n JOIN threads th ON th.id = n.thread_id
               WHERE th.project_id = ? ORDER BY n.at DESC`,
            )
            .all(projectId)
        : this.db
            .prepare(
              `SELECT n.* FROM notes n JOIN threads th ON th.id = n.thread_id
               WHERE th.project_id = ? AND n.thread_id = ? ORDER BY n.at DESC`,
            )
            .all(projectId, threadId)
    ) as NoteRow[];
    return rows.map(toNote);
  }

  /* repo pointers */
  createRepoPointer(projectId: string, req: CreateRepoPointerRequest): RepoPointer {
    const repo: RepoPointer = {
      id: newId(),
      project_id: projectId,
      name: req.name,
      git_url: req.git_url,
    };
    this.db
      .prepare(
        `INSERT INTO repo_pointers (id, project_id, name, git_url)
         VALUES (@id, @project_id, @name, @git_url)`,
      )
      .run(repo);
    return repo;
  }

  listRepoPointers(projectId: string): RepoPointer[] {
    const rows = this.db
      .prepare('SELECT * FROM repo_pointers WHERE project_id = ? ORDER BY name ASC')
      .all(projectId) as RepoRow[];
    return rows.map(toRepo);
  }

  /* draft metadata */
  createDraftMeta(
    projectId: string,
    req: CreateDraftMetaRequest,
    now: string,
  ): DraftMeta | undefined {
    if (this.getThread(projectId, req.thread_id) === undefined) return undefined;
    const draft: DraftMeta = {
      id: newId(),
      thread_id: req.thread_id,
      version: req.version,
      model: req.model,
      author: req.author,
      at: now,
    };
    this.db
      .prepare(
        `INSERT INTO draft_meta (id, thread_id, version, model, author, at)
         VALUES (@id, @thread_id, @version, @model, @author, @at)`,
      )
      .run(draft);
    return draft;
  }

  listDraftMeta(projectId: string, threadId?: string): DraftMeta[] {
    const rows = (
      threadId === undefined
        ? this.db
            .prepare(
              `SELECT d.* FROM draft_meta d JOIN threads th ON th.id = d.thread_id
               WHERE th.project_id = ? ORDER BY d.at DESC`,
            )
            .all(projectId)
        : this.db
            .prepare(
              `SELECT d.* FROM draft_meta d JOIN threads th ON th.id = d.thread_id
               WHERE th.project_id = ? AND d.thread_id = ? ORDER BY d.at DESC`,
            )
            .all(projectId, threadId)
    ) as DraftRow[];
    return rows.map(toDraft);
  }

  /* locks */
  acquireLock(projectId: string, req: AcquireLockRequest, now: string): AcquireResult {
    return this.db.transaction((): AcquireResult => {
      if (this.getThread(projectId, req.thread_id) === undefined) return { outcome: 'not-found' };
      const nowDate = new Date(now);
      const ttl = resolveTtlSeconds(req.ttl_seconds);
      const existing = this.getLockRow(req.thread_id);

      if (existing === undefined) {
        const lock: Lock = {
          thread_id: req.thread_id,
          locked_by: req.locked_by,
          locked_at: now,
          expires_at: computeExpiry(nowDate, ttl),
        };
        this.upsertLock(lock);
        return { outcome: 'acquired', lock };
      }

      const sameHolder = existing.locked_by === req.locked_by;
      if (sameHolder) {
        // Re-acquire by the holder == heartbeat: keep locked_at, extend expiry.
        const lock: Lock = { ...existing, expires_at: computeExpiry(nowDate, ttl) };
        this.upsertLock(lock);
        return { outcome: 'acquired', lock };
      }

      if (isExpired(existing.expires_at, nowDate)) {
        // Expired → free for a different actor to take over.
        const lock: Lock = {
          thread_id: req.thread_id,
          locked_by: req.locked_by,
          locked_at: now,
          expires_at: computeExpiry(nowDate, ttl),
        };
        this.upsertLock(lock);
        return { outcome: 'acquired', lock };
      }

      // Held by someone else and still valid → contended; return the current holder for presence.
      return { outcome: 'contended', lock: existing };
    })();
  }

  refreshLock(projectId: string, req: RefreshLockRequest, now: string): RefreshResult {
    return this.db.transaction((): RefreshResult => {
      if (this.getThread(projectId, req.thread_id) === undefined) return { outcome: 'not-found' };
      const existing = this.getLockRow(req.thread_id);
      if (existing === undefined) return { outcome: 'not-found' };
      if (existing.locked_by !== req.locked_by) return { outcome: 'contended', lock: existing };
      const ttl = resolveTtlSeconds(req.ttl_seconds);
      const lock: Lock = { ...existing, expires_at: computeExpiry(new Date(now), ttl) };
      this.upsertLock(lock);
      return { outcome: 'refreshed', lock };
    })();
  }

  releaseLock(projectId: string, req: ReleaseLockRequest, now: string): { released: boolean } {
    return this.db.transaction((): { released: boolean } => {
      // A thread outside the caller's project is not theirs to release — report not-released
      // (and never reveal whether the thread exists). The lock, if any, is left untouched.
      if (this.getThread(projectId, req.thread_id) === undefined) return { released: false };
      const existing = this.getLockRow(req.thread_id);
      if (existing === undefined) return { released: true };
      const sameHolder = existing.locked_by === req.locked_by;
      if (sameHolder || isExpired(existing.expires_at, new Date(now))) {
        this.db.prepare('DELETE FROM locks WHERE thread_id = ?').run(req.thread_id);
        return { released: true };
      }
      // A different actor still actively holds it — not the caller's to release.
      return { released: false };
    })();
  }

  listLocks(projectId: string, now: string): Lock[] {
    const rows = this.db
      .prepare(
        `SELECT l.* FROM locks l JOIN threads th ON th.id = l.thread_id
         WHERE th.project_id = ? AND l.expires_at > ? ORDER BY l.locked_at DESC`,
      )
      .all(projectId, now) as LockRow[];
    return rows.map(toLock);
  }

  private getLockRow(threadId: string): Lock | undefined {
    const row = this.db.prepare('SELECT * FROM locks WHERE thread_id = ?').get(threadId) as
      | LockRow
      | undefined;
    return row === undefined ? undefined : toLock(row);
  }

  private upsertLock(lock: Lock): void {
    this.db
      .prepare(
        `INSERT INTO locks (thread_id, locked_by, locked_at, expires_at)
         VALUES (@thread_id, @locked_by, @locked_at, @expires_at)
         ON CONFLICT(thread_id) DO UPDATE SET
           locked_by = excluded.locked_by,
           locked_at = excluded.locked_at,
           expires_at = excluded.expires_at`,
      )
      .run(lock);
  }

  /* tone files (last-write-wins per file) */
  putToneFile(projectId: string, req: PutToneFileRequest): PutToneFileResponse {
    return this.db.transaction((): PutToneFileResponse => {
      const incoming: ToneFile = {
        project_id: projectId,
        scope: req.scope,
        path: req.path,
        content: req.content,
        version_hash: req.version_hash,
        updated_by: req.updated_by,
        updated_at: normalizeIso(req.updated_at),
      };
      const existing = this.getToneFileRow(projectId, req.scope, req.path);
      if (existing === undefined || toneWriteWins(incoming, existing)) {
        this.upsertToneFile(incoming);
        return { accepted: true, file: incoming };
      }
      return { accepted: false, file: existing };
    })();
  }

  listToneFiles(projectId: string): ToneFile[] {
    const rows = this.db
      .prepare('SELECT * FROM tone_files WHERE project_id = ? ORDER BY scope ASC, path ASC')
      .all(projectId) as ToneRow[];
    return rows.map(toToneFile);
  }

  private getToneFileRow(projectId: string, scope: string, path: string): ToneFile | undefined {
    const row = this.db
      .prepare('SELECT * FROM tone_files WHERE project_id = ? AND scope = ? AND path = ?')
      .get(projectId, scope, path) as ToneRow | undefined;
    return row === undefined ? undefined : toToneFile(row);
  }

  private upsertToneFile(file: ToneFile): void {
    this.db
      .prepare(
        `INSERT INTO tone_files
           (project_id, scope, path, content, version_hash, updated_by, updated_at)
         VALUES
           (@project_id, @scope, @path, @content, @version_hash, @updated_by, @updated_at)
         ON CONFLICT(project_id, scope, path) DO UPDATE SET
           content = excluded.content,
           version_hash = excluded.version_hash,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(file);
  }

  /* learning changelog */
  createLearningEntry(
    projectId: string,
    req: CreateLearningEntryRequest,
    now: string,
  ): LearningEntry {
    const entry: LearningEntry = {
      id: newId(),
      project_id: projectId,
      scope: req.scope,
      summary: req.summary,
      applied_at: now,
      reverted_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO learning_entries (id, project_id, scope, summary, applied_at, reverted_at)
         VALUES (@id, @project_id, @scope, @summary, @applied_at, @reverted_at)`,
      )
      .run(entry);
    return entry;
  }

  listLearningEntries(projectId: string): LearningEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM learning_entries WHERE project_id = ? ORDER BY applied_at DESC')
      .all(projectId) as LearningRow[];
    return rows.map(toLearning);
  }

  revertLearningEntry(projectId: string, id: string, now: string): LearningEntry | undefined {
    return this.db.transaction((): LearningEntry | undefined => {
      const row = this.db
        .prepare('SELECT * FROM learning_entries WHERE id = ? AND project_id = ?')
        .get(id, projectId) as LearningRow | undefined;
      if (row === undefined) return undefined;
      if (row.reverted_at === null) {
        this.db.prepare('UPDATE learning_entries SET reverted_at = ? WHERE id = ?').run(now, id);
        return toLearning({ ...row, reverted_at: now });
      }
      return toLearning(row); // already reverted — idempotent
    })();
  }

  /* digest read model (server supplies metadata only; prose synthesized locally) */
  getDigestMetadata(projectId: string, req: DigestMetadataRequest, now: string): DigestMetadata {
    const windowStart = normalizeIso(req.window_start);
    const windowEnd = normalizeIso(req.window_end);

    const needsYou = this.db
      .prepare(
        `SELECT th.id AS thread_id, th.project_id AS project_id, th.subject AS subject,
                th.snippet AS snippet, th.sender AS sender, t.state AS state,
                t.importance AS importance, t.deadline AS deadline
         FROM tasks t JOIN threads th ON th.id = t.thread_id
         WHERE th.project_id = ? AND t.state IN ('needs-reply', 'follow-up')
         ORDER BY t.updated_at DESC`,
      )
      .all(projectId) as DigestThreadRef[];

    const promisesDue = this.db
      .prepare(
        `SELECT p.id AS promise_id, p.thread_id AS thread_id, th.subject AS subject,
                p.direction AS direction, p.text AS text, p.due_at AS due_at, p.status AS status
         FROM promises p JOIN threads th ON th.id = p.thread_id
         WHERE th.project_id = ? AND p.status IN ('open', 'overdue')
           AND p.due_at IS NOT NULL AND p.due_at <= ?
         ORDER BY p.due_at ASC`,
      )
      .all(projectId, windowEnd) as DigestPromiseEntry[];

    const handled = this.db
      .prepare(
        `SELECT tt.task_id AS task_id, t.thread_id AS thread_id, th.subject AS subject,
                tt."from" AS "from", tt."to" AS "to", tt.actor AS actor, tt.at AS at
         FROM task_transitions tt
           JOIN tasks t ON t.id = tt.task_id
           JOIN threads th ON th.id = t.thread_id
         WHERE th.project_id = ? AND tt.at >= ? AND tt.at <= ?
         ORDER BY tt.at DESC`,
      )
      .all(projectId, windowStart, windowEnd) as DigestTransitionEntry[];

    const drafted = this.db
      .prepare(
        `SELECT d.thread_id AS thread_id, th.subject AS subject, d.model AS model,
                d.author AS author, d.at AS at
         FROM draft_meta d JOIN threads th ON th.id = d.thread_id
         WHERE th.project_id = ? AND d.at >= ? AND d.at <= ?
         ORDER BY d.at DESC`,
      )
      .all(projectId, windowStart, windowEnd) as DigestDraftEntry[];

    return {
      project_id: projectId,
      generated_at: now,
      window_start: windowStart,
      window_end: windowEnd,
      needs_you: needsYou,
      promises_due: promisesDue,
      handled,
      drafted,
    };
  }

  /* lifecycle */
  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating its parent dir + applying migrations) a sqlite-backed {@link Repository}. Pass
 * {@link IN_MEMORY_DB} for a throwaway, fully-migrated database (tests).
 */
export function createSqliteRepository(dbPath: string): Repository {
  const db = openDatabase(dbPath);
  runMigrations(db);
  return new SqliteRepository(db);
}

export { IN_MEMORY_DB };
