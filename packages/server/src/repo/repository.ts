/**
 * The REPOSITORY LAYER (PROJECT.md §12 / PLAN.md §3, open Q #21/#29).
 *
 * Routes talk only to this interface — never to better-sqlite3 directly — so the metadata service
 * keeps a clean SQLite→Postgres swap path. The sqlite implementation lives in `sqlite.ts`.
 *
 * Every data method is SCOPED BY `projectId` (the authenticated project). Thread-/task-scoped
 * methods verify the referenced row belongs to that project and return `undefined` when it does not
 * (the route maps that to 404), so one project can never read or mutate another's data.
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
  DigestMetadata,
  DigestMetadataRequest,
  DraftMeta,
  LearningEntry,
  Lock,
  Note,
  Project,
  PromiseRecord,
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
  UpdatePromiseRequest,
  UpdateTaskRequest,
  UpsertThreadRequest,
} from '@mailordomo/shared';

/** Result of recording a task transition. `stale` means `expected_from` no longer matches. */
export type TransitionResult =
  | { ok: true; transition: TaskTransition; task: Task }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'stale'; currentState: TaskState };

/** Outcome of an acquire: a held lock, a contended lock (held by someone else), or no such thread. */
export type AcquireOutcome = 'acquired' | 'contended' | 'not-found';
export interface AcquireResult {
  outcome: AcquireOutcome;
  /** Set for `acquired` (the requester now holds it) and `contended` (the current holder). */
  lock?: Lock;
}

/** Outcome of a refresh: extended for the holder, contended by another, or no lock present. */
export type RefreshOutcome = 'refreshed' | 'contended' | 'not-found';
export interface RefreshResult {
  outcome: RefreshOutcome;
  lock?: Lock;
}

export interface Repository {
  /* projects / auth */
  /** Full project row INCLUDING `token_hash` — used only by auth/pairing, never serialized as-is. */
  getProjectById(id: string): Project | undefined;
  /** Insert-or-replace a project (seeding / tests). Stores the already-hashed token. */
  upsertProject(project: Project): void;

  /* threads */
  upsertThread(projectId: string, req: UpsertThreadRequest, now: string): Thread;
  listThreads(projectId: string): Thread[];
  getThread(projectId: string, threadId: string): Thread | undefined;

  /* tasks & transitions */
  createTask(projectId: string, req: CreateTaskRequest, now: string): Task | undefined;
  listTasks(projectId: string, threadId?: string): Task[];
  getTask(projectId: string, taskId: string): Task | undefined;
  updateTask(
    projectId: string,
    taskId: string,
    req: UpdateTaskRequest,
    now: string,
  ): Task | undefined;
  createTransition(
    projectId: string,
    taskId: string,
    req: CreateTaskTransitionRequest,
    now: string,
  ): TransitionResult;
  /** `undefined` when the task is not in the project (404); otherwise the transition history. */
  listTransitions(projectId: string, taskId: string): TaskTransition[] | undefined;

  /* promises */
  createPromise(
    projectId: string,
    req: CreatePromiseRequest,
    now: string,
  ): PromiseRecord | undefined;
  listPromises(projectId: string, threadId?: string): PromiseRecord[];
  updatePromise(
    projectId: string,
    promiseId: string,
    req: UpdatePromiseRequest,
  ): PromiseRecord | undefined;

  /* notes */
  createNote(projectId: string, req: CreateNoteRequest, now: string): Note | undefined;
  listNotes(projectId: string, threadId?: string): Note[];

  /* repo pointers */
  createRepoPointer(projectId: string, req: CreateRepoPointerRequest): RepoPointer;
  listRepoPointers(projectId: string): RepoPointer[];

  /* draft metadata */
  createDraftMeta(
    projectId: string,
    req: CreateDraftMetaRequest,
    now: string,
  ): DraftMeta | undefined;
  listDraftMeta(projectId: string, threadId?: string): DraftMeta[];

  /* locks (the double-handling guard) */
  acquireLock(projectId: string, req: AcquireLockRequest, now: string): AcquireResult;
  refreshLock(projectId: string, req: RefreshLockRequest, now: string): RefreshResult;
  releaseLock(projectId: string, req: ReleaseLockRequest, now: string): { released: boolean };
  /** Active (unexpired) locks for the project's threads. */
  listLocks(projectId: string, now: string): Lock[];

  /* tone files (last-write-wins per file) */
  putToneFile(projectId: string, req: PutToneFileRequest): PutToneFileResponse;
  listToneFiles(projectId: string): ToneFile[];

  /* learning changelog */
  createLearningEntry(
    projectId: string,
    req: CreateLearningEntryRequest,
    now: string,
  ): LearningEntry;
  listLearningEntries(projectId: string): LearningEntry[];
  revertLearningEntry(projectId: string, id: string, now: string): LearningEntry | undefined;

  /* digest (read model; server supplies metadata only) */
  getDigestMetadata(projectId: string, req: DigestMetadataRequest, now: string): DigestMetadata;

  /* lifecycle */
  close(): void;
}
