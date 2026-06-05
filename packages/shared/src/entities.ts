/**
 * Metadata-service entities (PROJECT.md §5) as the single source of truth for both client and
 * server. Each entity is the canonical STORED shape (what the server persists and returns). The
 * client→server request payloads are derived from these in `api.ts`.
 *
 * PRIVACY (Golden rule #3): every schema here is a `strictObject`, so no email-body / draft-body /
 * `.eml` / attachment-content field can ever be present — see `privacy.ts`. The only large-text
 * fields are the two sanctioned exceptions: `Note.body` (a user note) and `ToneFile.content`
 * (derived voice memory). No entity carries a draft or message body.
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
  EmailAddressSchema,
  HashSchema,
  IdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  SenderSchema,
  SnippetSchema,
} from './primitives';

/**
 * Project — an employer/workspace. `token_hash` is a HASH of the shared secret token, NEVER the
 * plaintext token (Golden rule #4 / PROJECT.md §5). The plaintext only ever travels in a pairing
 * request (see `api.ts`) and is never stored or returned.
 */
export const ProjectSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  token_hash: HashSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Thread — a mail conversation. `subject` / `snippet` / `sender` are the SANCTIONED shared-digest
 * fields (the only message-derived text allowed on the server); `snippet` is length-bounded.
 */
export const ThreadSchema = z.strictObject({
  id: IdSchema,
  project_id: IdSchema,
  mailbox_address: EmailAddressSchema,
  root_message_id: MessageIdSchema,
  subject: z.string(),
  snippet: SnippetSchema,
  sender: SenderSchema,
  /** Timestamp of the most recent message — a staleness input for the do-next ranker (§8). */
  last_message_at: IsoDateTimeSchema.nullable(),
  updated_at: IsoDateTimeSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

/**
 * Task — the work item attached to a thread. `deadline` is a hard due date; `follow_up_at` is when
 * a `waiting` task should flip to `follow-up`. `importance` feeds the ranker.
 */
export const TaskSchema = z.strictObject({
  id: IdSchema,
  thread_id: IdSchema,
  state: TaskStateSchema,
  deadline: IsoDateTimeSchema.nullable(),
  follow_up_at: IsoDateTimeSchema.nullable(),
  importance: ImportanceSchema,
  updated_at: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * TaskTransition — an actor-attributed state change (PROJECT.md §5/§6). `actor` powers the
 * digest's "what Simona handled"; `mode` records whether it was applied automatically or after a
 * human confirmed a proposed transition.
 */
export const TaskTransitionSchema = z.strictObject({
  id: IdSchema,
  task_id: IdSchema,
  from: TaskStateSchema,
  to: TaskStateSchema,
  actor: ActorSchema,
  at: IsoDateTimeSchema,
});
export type TaskTransition = z.infer<typeof TaskTransitionSchema>;

/**
 * Promise — one record of the 3-way tracker (PROJECT.md §7). `direction` buckets it; `due_at` is
 * the RESOLVED absolute deadline; `due_raw` carries the original natural-language deadline
 * ("by Friday") that the Phase 5 reconciler resolves against the message date + mailbox timezone.
 * Both are carried so extraction and reconciliation stay separable.
 */
export const PromiseSchema = z.strictObject({
  id: IdSchema,
  thread_id: IdSchema,
  direction: PromiseDirectionSchema,
  text: z.string().min(1),
  /** Resolved absolute deadline; null until/unless the reconciler resolves one. */
  due_at: IsoDateTimeSchema.nullable(),
  /** Raw relative deadline as extracted (e.g. "by Friday"); null if none was stated. */
  due_raw: z.string().nullable(),
  status: PromiseStatusSchema,
  actor: ActorSchema,
  created_at: IsoDateTimeSchema,
});
// Inferred type is `PromiseRecord`, NOT `Promise`, to avoid shadowing the global `Promise<T>` in
// any consumer that imports from the barrel (the schema stays `PromiseSchema`).
export type PromiseRecord = z.infer<typeof PromiseSchema>;

/**
 * Note — a USER-written per-thread note. NB: this `body` is the user's own text, NOT email
 * content; it is the single sanctioned `body` field that legitimately lives on the server
 * (privacy.ts). It is intentionally NOT bounded like a snippet.
 */
export const NoteSchema = z.strictObject({
  id: IdSchema,
  thread_id: IdSchema,
  author: ActorSchema,
  body: z.string(),
  at: IsoDateTimeSchema,
});
export type Note = z.infer<typeof NoteSchema>;

/**
 * RepoPointer — SHARED repo IDENTITY only: `project_id` + `name` + `git_url` (PROJECT.md §5/§10,
 * decision D13). `git_url` is a freeform string (scp-style `git@host:org/repo.git` is not a URL),
 * not a `z.url()`. The machine-local clone PATH is deliberately absent — see `LocalRepoConfig`.
 */
export const RepoPointerSchema = z.strictObject({
  id: IdSchema,
  project_id: IdSchema,
  name: z.string().min(1),
  git_url: z.string().min(1),
});
export type RepoPointer = z.infer<typeof RepoPointerSchema>;

/**
 * LocalRepoConfig — MACHINE-LOCAL repo config that must NEVER be sent to the metadata service.
 * It pairs a shared `RepoPointer` (by id) with this machine's clone path and pull policy. Modeled
 * separately from the shared DTO so the local path has no path to the wire (it is not part of any
 * server request/response). Kept strict for local validation hygiene.
 */
export const LocalRepoConfigSchema = z.strictObject({
  repo_pointer_id: IdSchema,
  /** Absolute path to the live clone on THIS machine; consumed locally via `claude --add-dir`. */
  local_path: z.string().min(1),
  /** Git-URL fallback mode: keep a read-only mirror fresh on a schedule (PROJECT.md §10). */
  active_pull: z.boolean(),
});
export type LocalRepoConfig = z.infer<typeof LocalRepoConfigSchema>;

/**
 * DraftMeta — draft METADATA ONLY (PROJECT.md §5 resolution / Golden rule #3). Records THAT a
 * draft exists, which model produced it, by whom, and when — for the "what Claude drafted" digest
 * line. The draft BODY stays local and MUST NOT appear here; strict-object validation rejects any
 * `body`/`draftBody`/`content` key.
 */
export const DraftMetaSchema = z.strictObject({
  id: IdSchema,
  thread_id: IdSchema,
  version: z.number().int().nonnegative(),
  model: ModelAliasSchema,
  author: ActorSchema,
  at: IsoDateTimeSchema,
});
export type DraftMeta = z.infer<typeof DraftMetaSchema>;

/**
 * Lock — the Jan/Simona double-handling guard (PROJECT.md §6). One lock per thread (`thread_id` is
 * the key). `expires_at` implements the timeout release; a heartbeat while a thread is open
 * extends it (server bumps `expires_at`).
 */
export const LockSchema = z.strictObject({
  thread_id: IdSchema,
  locked_by: ActorSchema,
  locked_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
});
export type Lock = z.infer<typeof LockSchema>;

/**
 * ToneFile — a synced tone-memory markdown file (PROJECT.md §3/§5). `content` is the second
 * sanctioned non-body field (derived voice memory, not raw email). `version_hash` is the
 * content hash the server uses to arbitrate last-write-wins per file. `scope` layers it
 * (project → mailbox → contact).
 */
export const ToneFileSchema = z.strictObject({
  project_id: IdSchema,
  scope: ToneScopeSchema,
  /** Stable path/key identifying the file within its scope (e.g. `contact/jan@acme.com.md`). */
  path: z.string().min(1),
  content: z.string(),
  version_hash: HashSchema,
  updated_by: ActorSchema,
  updated_at: IsoDateTimeSchema,
});
export type ToneFile = z.infer<typeof ToneFileSchema>;

/**
 * LearningEntry — one revertable entry in the silent-learning changelog (PROJECT.md §6). Sourced
 * from recurring draft instructions and the draft-vs-sent diff. `reverted_at` null = still
 * applied; set = reverted. `id` + `project_id` are required to address/scope a revert (the bare
 * §5 tuple `(scope, summary, applied_at, reverted_at?)` plus the keys needed to act on it).
 */
export const LearningEntrySchema = z.strictObject({
  id: IdSchema,
  project_id: IdSchema,
  scope: ToneScopeSchema,
  summary: z.string().min(1),
  applied_at: IsoDateTimeSchema,
  reverted_at: IsoDateTimeSchema.nullable(),
});
export type LearningEntry = z.infer<typeof LearningEntrySchema>;
