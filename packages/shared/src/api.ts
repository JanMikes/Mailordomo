/**
 * Metadata-service API request/response contracts (PROJECT.md §3 Layer 2; PLAN.md §7 Phase 2).
 *
 * PRIVACY (Golden rule #3 — the load-bearing reason this module is strict everywhere):
 *   EVERY request schema here is a `strictObject`. A request is a payload the local app sends TO
 *   the metadata service, so strict rejection of unknown keys is what structurally enforces
 *   "email bodies never leave the machine": a payload carrying `body`/`draftBody`/`emlContent`/
 *   any undeclared key FAILS validation before it can be serialized. See `privacy.ts`. The one
 *   declared `body` is `CreateNoteRequest.body` (a user note); the one declared large-text field is
 *   `PutToneFileRequest.content` (derived tone memory). No request carries a message/draft body.
 *
 * Bearer auth: every request except pairing authenticates via the `Authorization` header (project
 * token), NOT a body field — so the body schemas stay clean and contain no secret.
 *
 * Single-item success responses ARE the corresponding entity schemas (e.g. a created Task is
 * returned as `TaskSchema`); list/aggregate/result responses are defined explicitly below.
 */
import { z } from 'zod';
import {
  ActorSchema,
  ImportanceSchema,
  ModelAliasSchema,
  PromiseDirectionSchema,
  PromiseStatusSchema,
  TaskStateSchema,
  ToneScopeSchema,
} from './enums';
import {
  DraftMetaSchema,
  LearningEntrySchema,
  LockSchema,
  NoteSchema,
  ProjectSchema,
  PromiseSchema,
  RepoPointerSchema,
  TaskSchema,
  TaskTransitionSchema,
  ThreadSchema,
  ToneFileSchema,
} from './entities';
import { DigestMetadataSchema } from './digest';
import { TodayReadModelSchema } from './today';
import { ProjectsBoardSchema } from './projects-board';
import { AppSettingsSchema } from './settings';
import {
  EmailAddressSchema,
  HashSchema,
  IdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  SenderSchema,
  SnippetSchema,
} from './primitives';

/* -------------------------------------------------------------------------- */
/* Generic                                                                     */
/* -------------------------------------------------------------------------- */

/** Uniform error envelope for any non-2xx response. */
export const ApiErrorSchema = z.strictObject({
  error: z.string(),
  code: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------------------- */
/* Auth & pairing                                                              */
/* -------------------------------------------------------------------------- */

/** A project as safely echoed to clients: identity only, NEVER the `token_hash`. */
export const AuthedProjectSchema = ProjectSchema.omit({ token_hash: true });
export type AuthedProject = z.infer<typeof AuthedProjectSchema>;

/**
 * Pair this machine to a shared project. `token` is the PLAINTEXT shared secret — this is the only
 * place it travels (the server hashes it to compare with `token_hash`; it is never stored or
 * returned). Strict, so nothing else can ride along.
 */
export const PairRequestSchema = z.strictObject({
  project_id: IdSchema,
  token: z.string().min(1),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.strictObject({
  project: AuthedProjectSchema,
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Threads (push the sanctioned subject/snippet/sender; upsert by root message) */
/* -------------------------------------------------------------------------- */

export const UpsertThreadRequestSchema = z.strictObject({
  project_id: IdSchema,
  mailbox_address: EmailAddressSchema,
  root_message_id: MessageIdSchema,
  subject: z.string(),
  snippet: SnippetSchema,
  sender: SenderSchema,
  last_message_at: IsoDateTimeSchema.nullable().optional(),
});
export type UpsertThreadRequest = z.infer<typeof UpsertThreadRequestSchema>;

export const ThreadListResponseSchema = z.array(ThreadSchema);
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Tasks & transitions                                                         */
/* -------------------------------------------------------------------------- */

export const CreateTaskRequestSchema = z.strictObject({
  thread_id: IdSchema,
  state: TaskStateSchema.optional(), // server defaults to the initial state
  deadline: IsoDateTimeSchema.nullable().optional(),
  follow_up_at: IsoDateTimeSchema.nullable().optional(),
  importance: ImportanceSchema.optional(), // server defaults to 'normal'
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** PATCH a task. Direct field edits; state changes SHOULD go through a transition (records actor). */
export const UpdateTaskRequestSchema = z.strictObject({
  deadline: IsoDateTimeSchema.nullable().optional(),
  follow_up_at: IsoDateTimeSchema.nullable().optional(),
  importance: ImportanceSchema.optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const TaskListResponseSchema = z.array(TaskSchema);
export type TaskListResponse = z.infer<typeof TaskListResponseSchema>;

/**
 * Record a state transition (the actor-attributed way to change state). The server derives `from`
 * from the task's current state and assigns `at`; `expected_from` optionally guards against a stale
 * transition (optimistic concurrency). The response is the created `TaskTransition`.
 */
export const CreateTaskTransitionRequestSchema = z.strictObject({
  to: TaskStateSchema,
  actor: ActorSchema,
  expected_from: TaskStateSchema.optional(),
});
export type CreateTaskTransitionRequest = z.infer<typeof CreateTaskTransitionRequestSchema>;

export const TaskTransitionListResponseSchema = z.array(TaskTransitionSchema);
export type TaskTransitionListResponse = z.infer<typeof TaskTransitionListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Promises (3-way tracker)                                                    */
/* -------------------------------------------------------------------------- */

export const CreatePromiseRequestSchema = z.strictObject({
  thread_id: IdSchema,
  direction: PromiseDirectionSchema,
  text: z.string().min(1),
  due_at: IsoDateTimeSchema.nullable().optional(),
  due_raw: z.string().nullable().optional(),
  status: PromiseStatusSchema.optional(), // server defaults to 'open'
  actor: ActorSchema,
});
export type CreatePromiseRequest = z.infer<typeof CreatePromiseRequestSchema>;

/** PATCH a promise — e.g. the reconciler resolving `due_at` or flipping `status`. */
export const UpdatePromiseRequestSchema = z.strictObject({
  direction: PromiseDirectionSchema.optional(),
  text: z.string().min(1).optional(),
  due_at: IsoDateTimeSchema.nullable().optional(),
  due_raw: z.string().nullable().optional(),
  status: PromiseStatusSchema.optional(),
  actor: ActorSchema.optional(),
});
export type UpdatePromiseRequest = z.infer<typeof UpdatePromiseRequestSchema>;

export const PromiseListResponseSchema = z.array(PromiseSchema);
export type PromiseListResponse = z.infer<typeof PromiseListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Notes (the one sanctioned `body` — a USER note, not email content)          */
/* -------------------------------------------------------------------------- */

export const CreateNoteRequestSchema = z.strictObject({
  thread_id: IdSchema,
  author: ActorSchema,
  body: z.string(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

export const NoteListResponseSchema = z.array(NoteSchema);
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Repo pointers (shared IDENTITY only — local path never crosses)             */
/* -------------------------------------------------------------------------- */

export const CreateRepoPointerRequestSchema = z.strictObject({
  project_id: IdSchema,
  name: z.string().min(1),
  git_url: z.string().min(1),
});
export type CreateRepoPointerRequest = z.infer<typeof CreateRepoPointerRequestSchema>;

export const RepoPointerListResponseSchema = z.array(RepoPointerSchema);
export type RepoPointerListResponse = z.infer<typeof RepoPointerListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Draft metadata (METADATA ONLY — strict rejects any body field)              */
/* -------------------------------------------------------------------------- */

export const CreateDraftMetaRequestSchema = z.strictObject({
  thread_id: IdSchema,
  version: z.number().int().nonnegative(),
  model: ModelAliasSchema,
  author: ActorSchema,
});
export type CreateDraftMetaRequest = z.infer<typeof CreateDraftMetaRequestSchema>;

export const DraftMetaListResponseSchema = z.array(DraftMetaSchema);
export type DraftMetaListResponse = z.infer<typeof DraftMetaListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Locks (Jan/Simona double-handling guard; acquire/refresh/release + timeout) */
/* -------------------------------------------------------------------------- */

export const AcquireLockRequestSchema = z.strictObject({
  thread_id: IdSchema,
  locked_by: ActorSchema,
  /** Time-to-live before automatic timeout release; server applies its default if omitted. */
  ttl_seconds: z.number().int().positive().optional(),
});
export type AcquireLockRequest = z.infer<typeof AcquireLockRequestSchema>;

/**
 * Acquire result. `acquired=true` ⇒ `lock` is now held by the requester. `acquired=false` ⇒ a
 * different actor holds it; `lock` is the CURRENT holder's lock (so the UI can show presence).
 */
export const AcquireLockResponseSchema = z.strictObject({
  acquired: z.boolean(),
  lock: LockSchema,
});
export type AcquireLockResponse = z.infer<typeof AcquireLockResponseSchema>;

/** Heartbeat to extend an already-held lock's `expires_at` (PROJECT.md §6 timeout refresh). */
export const RefreshLockRequestSchema = z.strictObject({
  thread_id: IdSchema,
  locked_by: ActorSchema,
  ttl_seconds: z.number().int().positive().optional(),
});
export type RefreshLockRequest = z.infer<typeof RefreshLockRequestSchema>;

export const ReleaseLockRequestSchema = z.strictObject({
  thread_id: IdSchema,
  locked_by: ActorSchema,
});
export type ReleaseLockRequest = z.infer<typeof ReleaseLockRequestSchema>;

export const ReleaseLockResponseSchema = z.strictObject({
  released: z.boolean(),
});
export type ReleaseLockResponse = z.infer<typeof ReleaseLockResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Digest metadata (server supplies metadata only; prose synthesized locally)  */
/* -------------------------------------------------------------------------- */

export const DigestMetadataRequestSchema = z.strictObject({
  project_id: IdSchema,
  window_start: IsoDateTimeSchema,
  window_end: IsoDateTimeSchema,
});
export type DigestMetadataRequest = z.infer<typeof DigestMetadataRequestSchema>;

/** The digest metadata response is the aggregate read model from `digest.ts`. */
export const DigestMetadataResponseSchema = DigestMetadataSchema;
export type DigestMetadataResponse = z.infer<typeof DigestMetadataResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Tone-file sync (last-write-wins per file; `content` is the sanctioned text) */
/* -------------------------------------------------------------------------- */

/**
 * Push a tone file. The server arbitrates last-write-wins per file by comparing `updated_at` (and
 * `version_hash` to short-circuit no-op writes). `content` is derived voice memory — the second
 * sanctioned non-body field.
 */
export const PutToneFileRequestSchema = z.strictObject({
  project_id: IdSchema,
  scope: ToneScopeSchema,
  path: z.string().min(1),
  content: z.string(),
  version_hash: HashSchema,
  updated_by: ActorSchema,
  updated_at: IsoDateTimeSchema,
});
export type PutToneFileRequest = z.infer<typeof PutToneFileRequestSchema>;

/**
 * Put result under LWW. `accepted=true` ⇒ the client's version won and is authoritative.
 * `accepted=false` ⇒ the server already had a newer version; `file` is that authoritative version
 * and the client should adopt it. Either way `file` is the post-resolution truth.
 */
export const PutToneFileResponseSchema = z.strictObject({
  accepted: z.boolean(),
  file: ToneFileSchema,
});
export type PutToneFileResponse = z.infer<typeof PutToneFileResponseSchema>;

export const ToneFileListResponseSchema = z.array(ToneFileSchema);
export type ToneFileListResponse = z.infer<typeof ToneFileListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Learning changelog (silent, revertable)                                     */
/* -------------------------------------------------------------------------- */

export const CreateLearningEntryRequestSchema = z.strictObject({
  project_id: IdSchema,
  scope: ToneScopeSchema,
  summary: z.string().min(1),
});
export type CreateLearningEntryRequest = z.infer<typeof CreateLearningEntryRequestSchema>;

/**
 * Revert a learning entry (sets `reverted_at`). The entry id is a path param; the empty strict body
 * carries nothing — and, being strict, still rejects a smuggled body field. The response is the
 * updated `LearningEntry`.
 */
export const RevertLearningEntryRequestSchema = z.strictObject({});
export type RevertLearningEntryRequest = z.infer<typeof RevertLearningEntryRequestSchema>;

export const LearningEntryListResponseSchema = z.array(LearningEntrySchema);
export type LearningEntryListResponse = z.infer<typeof LearningEntryListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Today + settings (LOCAL backend ↔ frontend; NOT server-bound — D29)         */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/today` response — the assembled Today read model (`today.ts`). This is a LOCAL hop
 * (backend → frontend); it never reaches the metadata server, but it is still strict + body-free by
 * construction (it carries only metadata + the sanctioned subject/snippet/sender).
 */
export const TodayResponseSchema = TodayReadModelSchema;
export type TodayResponse = z.infer<typeof TodayResponseSchema>;

/** `GET`/`PUT /api/settings` response — the full local {@link AppSettingsSchema}. */
export const SettingsResponseSchema = AppSettingsSchema;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

/**
 * `GET /api/projects-board` response — the assembled projects board (`projects-board.ts`). A LOCAL
 * hop (backend → frontend); strict + body-free by construction (subject/snippet/sender + state
 * metadata only — D32).
 */
export const ProjectsBoardResponseSchema = ProjectsBoardSchema;
export type ProjectsBoardResponse = z.infer<typeof ProjectsBoardResponseSchema>;

/**
 * `GET /api/project` response — the configured project's identity (D32). It is {@link AuthedProject}
 * shaped, but `name` is NULLABLE here: when the metadata service can't be reached to resolve it via
 * `pair()`, the backend still answers with the known id and a `null` name rather than failing.
 */
export const ProjectResponseSchema = AuthedProjectSchema.extend({
  name: z.string().nullable(),
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

// `PUT /api/settings` request: surfaced here alongside the response for symmetry. It is the SAME
// binding declared in `settings.ts` (a re-export, not a new declaration), so the barrel re-exporting
// both modules is not an ambiguous-name collision.
export { UpdateSettingsRequestSchema } from './settings';
export type { UpdateSettingsRequest } from './settings';
