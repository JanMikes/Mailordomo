/**
 * MetadataClient — the typed HTTP client the local backend uses to talk to the metadata service
 * (PROJECT.md §3 Layer 2). It is the ONLY component that crosses the privacy boundary outbound, so
 * its design is privacy-load-bearing:
 *
 * PRIVACY (Golden rule #3 — bodies never leave): every request body type here is a strict shared
 * DTO from `@mailordomo/shared`. Those schemas are `z.strictObject`, so a smuggled email/draft body
 * (or any undeclared key) cannot even be constructed as a valid argument, and the server would
 * reject it anyway. This client deliberately exposes NO method or field that could transmit a
 * message body or draft body — it pushes METADATA ONLY and reads metadata back. There is no
 * two-way sync here: the client writes metadata to the server (the truth for metadata) and reads it
 * back; the local SQLite cache mirrors email truth separately (Golden rule #2).
 *
 * INJECTABLE FETCH (the test seam — VERIFIED): `config.fetch` defaults to the global `fetch`. Tests
 * inject a `fetch` that routes to an in-process metadata server instead of hitting the network. The
 * server package is declared as a backend devDependency precisely so the separate integration
 * test-author can spin up `createApp` in-process. The intended pattern (round-trip confirmed green):
 *
 *   // The server ships ready-made helpers for exactly this; reuse them rather than hand-wiring a repo:
 *   import { makeApp, seedProject, PROJECT_A } from '../../../server/src/test-helpers';
 *   const { app, repo } = makeApp();          // fresh in-memory, fully-migrated Hono app + repo
 *   seedProject(repo, PROJECT_A);             // stores only the token HASH, as production does
 *   const client = new MetadataClient({
 *     baseUrl: 'http://metadata.local',       // any absolute base; only the path is used
 *     projectId: PROJECT_A.id, token: PROJECT_A.token,
 *     fetch: (input, init) => app.fetch(new Request(input, init)),
 *   });
 *   // ... exercise client.pair()/upsertThread()/acquireLock()/... then repo.close().
 *
 * `app.fetch` IS a `(req: Request) => Promise<Response>` (Hono apps are fetch handlers), so it slots
 * straight into this seam with no extra adapter — the client exercises the REAL request/response
 * path (headers, auth, zod validation) against the REAL server, just without a socket. (The bare
 * `createApp` from `../../../server/src/app` + `createSqliteRepository(IN_MEMORY_DB)` works too if a
 * test prefers to wire its own repo.)
 */
import type { z } from 'zod';
import type {
  AcquireLockRequest,
  AcquireLockResponse,
  AuthedProject,
  CreateDraftMetaRequest,
  CreateLearningEntryRequest,
  CreatePromiseRequest,
  CreateTaskRequest,
  CreateTaskTransitionRequest,
  DigestTransitionEntry,
  DraftMeta,
  LearningEntry,
  Lock,
  PromiseRecord,
  PutToneFileRequest,
  PutToneFileResponse,
  RefreshLockRequest,
  ReleaseLockRequest,
  ReleaseLockResponse,
  Task,
  TaskTransition,
  Thread,
  ToneFile,
  UpdateTaskRequest,
  UpsertThreadRequest,
} from '@mailordomo/shared';
import {
  AcquireLockResponseSchema,
  ApiErrorSchema,
  DigestTransitionListResponseSchema,
  DraftMetaListResponseSchema,
  DraftMetaSchema,
  LearningEntryListResponseSchema,
  LearningEntrySchema,
  LockSchema,
  PairResponseSchema,
  PromiseListResponseSchema,
  PromiseSchema,
  PutToneFileResponseSchema,
  TaskListResponseSchema,
  TaskSchema,
  TaskTransitionSchema,
  ThreadListResponseSchema,
  ThreadSchema,
  ToneFileListResponseSchema,
  ReleaseLockResponseSchema,
} from '@mailordomo/shared';
import { MetadataAuthError, MetadataError, MetadataValidationError } from './errors';

/**
 * The subset of the WHATWG `fetch` signature this client relies on. Declared structurally so any
 * compatible function — the global `fetch` OR a Hono app's `app.fetch` (the test seam) — satisfies
 * it without an adapter.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MetadataClientConfig {
  /** Absolute base URL of the metadata service, e.g. `http://localhost:8787`. No trailing slash needed. */
  readonly baseUrl: string;
  /** The shared project id (sent as the `X-Project-Id` header and used to scope every call). */
  readonly projectId: string;
  /** The plaintext project token (sent as `Authorization: Bearer <token>`). Never logged. */
  readonly token: string;
  /** Injectable fetch (defaults to the global `fetch`). Tests point this at an in-process server. */
  readonly fetch?: FetchLike;
}

/** Header carrying the project id alongside the bearer token (matches the server's `PROJECT_ID_HEADER`). */
const PROJECT_ID_HEADER = 'X-Project-Id';

type Schema<T> = z.ZodType<T>;

export class MetadataClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly token: string;
  private readonly doFetch: FetchLike;

  constructor(config: MetadataClientConfig) {
    // Normalize: drop a single trailing slash so `${baseUrl}/threads` never doubles up.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.projectId = config.projectId;
    this.token = config.token;
    // Bind so a destructured global `fetch` keeps its correct `this` (some runtimes require it).
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The shared project id this client is scoped to (the single Today project — D29). */
  getProjectId(): string {
    return this.projectId;
  }

  /* ----------------------------- Pairing / auth ----------------------------- */

  /**
   * Verify the configured token against the metadata service (`POST /pair`). Resolves with the
   * authed project (identity only — never the token hash) on success; throws {@link MetadataAuthError}
   * if the credentials are rejected. Use this as the metadata-layer health check.
   */
  async pair(): Promise<AuthedProject> {
    const res = await this.request('POST', '/pair', {
      project_id: this.projectId,
      token: this.token,
    });
    const parsed = await this.parse(res, PairResponseSchema);
    return parsed.project;
  }

  /* -------------------------------- Threads --------------------------------- */

  /** Upsert a thread's sanctioned shared fields (subject/snippet/sender) by its root message. */
  async upsertThread(req: UpsertThreadRequest): Promise<Thread> {
    const res = await this.request('POST', '/threads', req);
    return this.parse(res, ThreadSchema);
  }

  /** List every thread the metadata service holds for this project. */
  async listThreads(): Promise<Thread[]> {
    const res = await this.request('GET', '/threads');
    return this.parse(res, ThreadListResponseSchema);
  }

  /** Fetch a single thread by id (scoped to this project). */
  async getThread(id: string): Promise<Thread> {
    const res = await this.request('GET', `/threads/${encodeURIComponent(id)}`);
    return this.parse(res, ThreadSchema);
  }

  /* --------------------------------- Tasks ---------------------------------- */

  /** Create a task on a thread. The server defaults state/importance when omitted. */
  async createTask(req: CreateTaskRequest): Promise<Task> {
    const res = await this.request('POST', '/tasks', req);
    return this.parse(res, TaskSchema);
  }

  /** List tasks, optionally filtered to a single thread. */
  async listTasks(threadId?: string): Promise<Task[]> {
    const path =
      threadId === undefined ? '/tasks' : `/tasks?thread_id=${encodeURIComponent(threadId)}`;
    const res = await this.request('GET', path);
    return this.parse(res, TaskListResponseSchema);
  }

  /**
   * PATCH a task's direct fields (deadline / follow_up_at / importance). Used by the Today snooze
   * action to set `follow_up_at`. Metadata only; state changes go through {@link createTransition}.
   */
  async updateTask(taskId: string, req: UpdateTaskRequest): Promise<Task> {
    const res = await this.request('PATCH', `/tasks/${encodeURIComponent(taskId)}`, req);
    return this.parse(res, TaskSchema);
  }

  /**
   * Record an actor-attributed state transition (`POST /tasks/:id/transitions`). The server derives
   * `from` from the task's current state. Used by the Today mark-done action. This is a METADATA
   * write — it never sends mail (Golden rule #1).
   */
  async createTransition(
    taskId: string,
    req: CreateTaskTransitionRequest,
  ): Promise<TaskTransition> {
    const res = await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/transitions`, req);
    return this.parse(res, TaskTransitionSchema);
  }

  /**
   * Read every actor-attributed task transition in `[window.start, window.end]` (project-wide,
   * newest first), each with its thread subject — the body-free "what was handled" feed for the
   * morning digest's "what Simona handled" section (Golden rule #3: actor attribution on server
   * metadata, never her message body). Bounds are sent as ISO query params.
   */
  async listTransitionsInWindow(window: {
    readonly start: string;
    readonly end: string;
  }): Promise<DigestTransitionEntry[]> {
    const qs = `?window_start=${encodeURIComponent(window.start)}&window_end=${encodeURIComponent(
      window.end,
    )}`;
    const res = await this.request('GET', `/transitions${qs}`);
    return this.parse(res, DigestTransitionListResponseSchema);
  }

  /* -------------------------------- Promises -------------------------------- */

  /** Create a 3-way promise record on a thread (the reconciler / dev seed writes these). */
  async createPromise(req: CreatePromiseRequest): Promise<PromiseRecord> {
    const res = await this.request('POST', '/promises', req);
    return this.parse(res, PromiseSchema);
  }

  /** List the 3-way promise records, optionally filtered to a single thread (feeds the Today view). */
  async listPromises(threadId?: string): Promise<PromiseRecord[]> {
    const path =
      threadId === undefined ? '/promises' : `/promises?thread_id=${encodeURIComponent(threadId)}`;
    const res = await this.request('GET', path);
    return this.parse(res, PromiseListResponseSchema);
  }

  /* ------------------------------ Draft metadata ---------------------------- */

  /**
   * Create draft METADATA (model/author/version — never body, Golden rule #3). Records THAT a draft
   * exists; the draft text stays local. Used by the dev seed and (later) the draft flow.
   */
  async createDraftMeta(req: CreateDraftMetaRequest): Promise<DraftMeta> {
    const res = await this.request('POST', '/drafts', req);
    return this.parse(res, DraftMetaSchema);
  }

  /**
   * List draft METADATA (existence/model/author/timestamp — never body, Golden rule #3), optionally
   * filtered to a single thread. The Today view uses this only to flag `hasDraftReady` on a card.
   */
  async listDraftMeta(threadId?: string): Promise<DraftMeta[]> {
    const path =
      threadId === undefined ? '/drafts' : `/drafts?thread_id=${encodeURIComponent(threadId)}`;
    const res = await this.request('GET', path);
    return this.parse(res, DraftMetaListResponseSchema);
  }

  /* --------------------------------- Locks ---------------------------------- */

  /**
   * Acquire (or heartbeat-reacquire / take over an expired) lock on a thread. `acquired=false` means
   * a DIFFERENT actor holds it; `lock` is then the current holder (for the presence indicator). The
   * server returns 409 in that case — which this client surfaces as the `{acquired:false}` body, NOT
   * as a thrown error, because contention is an expected outcome the caller must inspect.
   */
  async acquireLock(req: AcquireLockRequest): Promise<AcquireLockResponse> {
    const res = await this.request('POST', '/locks/acquire', req, { allowStatuses: [409] });
    return this.parse(res, AcquireLockResponseSchema);
  }

  /** Heartbeat an already-held lock, extending its `expires_at`. Throws 409 if held by another. */
  async refreshLock(req: RefreshLockRequest): Promise<Lock> {
    const res = await this.request('POST', '/locks/refresh', req);
    return this.parse(res, LockSchema);
  }

  /** Release a lock. `released=false` means a different active holder owns it (not freed). */
  async releaseLock(req: ReleaseLockRequest): Promise<ReleaseLockResponse> {
    const res = await this.request('POST', '/locks/release', req);
    return this.parse(res, ReleaseLockResponseSchema);
  }

  /** List the project's active (unexpired) locks — the cross-instance presence primitive. */
  async listLocks(): Promise<Lock[]> {
    const res = await this.request('GET', '/locks');
    return this.parse(res, LockSchema.array());
  }

  /* ----------------------- Tone files (LWW per file) ------------------------ */

  /**
   * Push a tone-memory file (`PUT /tone`). The SERVER arbitrates last-write-wins per file (Golden
   * rule #2 — the server is the sole arbiter, never a two-way merge): `accepted` is the verdict and
   * `file` is ALWAYS the post-resolution authoritative version the caller must adopt LOCALLY (whole
   * file, never a field merge). `content` is the sanctioned derived-memory field; this is the second
   * (and only other) thing besides `LearningEntry.summary` that Phase 6 may send across the boundary.
   */
  async putToneFile(req: PutToneFileRequest): Promise<PutToneFileResponse> {
    const res = await this.request('PUT', '/tone', req);
    return this.parse(res, PutToneFileResponseSchema);
  }

  /** List every tone file the server holds for this project (the pull side of LWW sync). */
  async listToneFiles(): Promise<ToneFile[]> {
    const res = await this.request('GET', '/tone');
    return this.parse(res, ToneFileListResponseSchema);
  }

  /* --------------------- Learning changelog (revertable) -------------------- */

  /**
   * Record one silent-learning changelog entry (`POST /learning`). The request carries ONLY a short
   * `summary` (never a draft/message body — the before/after tone snapshots stay LOCAL for revert);
   * the server assigns `id` + `applied_at` and returns the created {@link LearningEntry}.
   */
  async createLearningEntry(req: CreateLearningEntryRequest): Promise<LearningEntry> {
    const res = await this.request('POST', '/learning', req);
    return this.parse(res, LearningEntrySchema);
  }

  /** List the project's learning changelog (applied + reverted entries). */
  async listLearningEntries(): Promise<LearningEntry[]> {
    const res = await this.request('GET', '/learning');
    return this.parse(res, LearningEntryListResponseSchema);
  }

  /**
   * Revert a learning entry by id (`POST /learning/:id/revert`, empty strict body). Sets `reverted_at`
   * server-side; idempotent. Reverting the local tone-file CONTENT from the before-snapshot is the
   * caller's job (see `learning/learn.ts`) — this only flips the shared changelog flag.
   */
  async revertLearningEntry(id: string): Promise<LearningEntry> {
    const res = await this.request('POST', `/learning/${encodeURIComponent(id)}/revert`, {});
    return this.parse(res, LearningEntrySchema);
  }

  /* ------------------------------- Internals -------------------------------- */

  /**
   * Issue an authenticated request. Always attaches `Authorization: Bearer <token>` +
   * `X-Project-Id`. A `body` is JSON-serialized (it is one of the strict shared DTOs, so it can
   * never carry an undeclared field). Throws on a non-2xx status — except those in
   * `opts.allowStatuses`, which the caller handles (e.g. lock contention's 409).
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allowStatuses?: readonly number[] },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      [PROJECT_ID_HEADER]: this.projectId,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      // Transport-level failure (DNS, refused connection, etc.) — no HTTP response arrived.
      throw new MetadataError(
        `metadata request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
      );
    }

    if (res.ok || opts?.allowStatuses?.includes(res.status)) return res;
    throw await this.toError(res);
  }

  /** Validate a response body against a shared zod DTO; throw {@link MetadataValidationError} on drift. */
  private async parse<T>(res: Response, schema: Schema<T>): Promise<T> {
    const json = (await res.json()) as unknown;
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new MetadataValidationError(
        'metadata service response failed contract validation',
        res.status,
      );
    }
    return result.data;
  }

  /** Build a typed error from a non-2xx response, reading the server's `ApiError` envelope if present. */
  private async toError(res: Response): Promise<MetadataError> {
    let code: string | undefined;
    let message = `metadata request failed with status ${res.status}`;
    try {
      const parsed = ApiErrorSchema.safeParse((await res.json()) as unknown);
      if (parsed.success) {
        code = parsed.data.code;
        message = parsed.data.error;
      }
    } catch {
      // Non-JSON or empty error body — keep the generic status message.
    }
    if (res.status === 401) return new MetadataAuthError(message, code);
    return new MetadataError(message, res.status, code);
  }
}
