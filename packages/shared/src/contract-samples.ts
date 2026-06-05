/**
 * Canonical valid samples + a registry of every strict contract schema, shared by the test suite.
 *
 * This is a TEST-SUPPORT module (not exported from the barrel, not a `*.test.ts`, so Vitest does
 * not execute it — it is only imported by the test files). It exists so the privacy matrix can
 * iterate over EVERY entity + server-bound request DTO programmatically (exhaustive coverage, not a
 * hand-picked subset) and so round-trip tests share one set of canonical inputs.
 *
 * The samples are deliberately NOT typed with `satisfies <Type>`: the runtime `schema.parse(valid)`
 * assertions in the tests are the real check that each sample is well-formed, and keeping these as
 * plain `Record<string, unknown>` lets the privacy tests spread an extra (forbidden) key onto them.
 */
import {
  AcquireLockRequestSchema,
  CreateDraftMetaRequestSchema,
  CreateLearningEntryRequestSchema,
  CreateNoteRequestSchema,
  CreatePromiseRequestSchema,
  CreateRepoPointerRequestSchema,
  CreateTaskRequestSchema,
  CreateTaskTransitionRequestSchema,
  DigestMetadataRequestSchema,
  DraftMetaSchema,
  LearningEntrySchema,
  LocalRepoConfigSchema,
  LockSchema,
  NoteSchema,
  PairRequestSchema,
  ProjectSchema,
  PromiseSchema,
  PutToneFileRequestSchema,
  RefreshLockRequestSchema,
  ReleaseLockRequestSchema,
  RepoPointerSchema,
  RevertLearningEntryRequestSchema,
  TaskSchema,
  TaskTransitionSchema,
  ThreadSchema,
  ToneFileSchema,
  UpdatePromiseRequestSchema,
  UpdateTaskRequestSchema,
  UpsertThreadRequestSchema,
} from './index';

/** Minimal structural view of a zod schema: enough to call `.parse()` in a heterogeneous list. */
export interface Parsable {
  parse(data: unknown): unknown;
}

/** One strict contract under test, with everything the suites need to exercise it generically. */
export interface ContractCase {
  /** Human-readable schema name (used in test titles). */
  readonly name: string;
  /** The schema itself, narrowed to the parse surface so the array can stay heterogeneous. */
  readonly schema: Parsable;
  /** The declared keys of the (strict) object shape — used for structural privacy assertions. */
  readonly shapeKeys: readonly string[];
  /** A canonical, valid payload that must `parse()` and round-trip deep-equal. */
  readonly valid: Record<string, unknown>;
  /** True only for the schemas where a `body` field is a SANCTIONED exception (Note). */
  readonly allowsBody: boolean;
  /** True only for the schemas where a `content` field is a SANCTIONED exception (ToneFile). */
  readonly allowsContent: boolean;
  /**
   * True for the stored metadata-service entities (PROJECT.md §5). False for API request DTOs and
   * for `LocalRepoConfig`, which is machine-local config that is NEVER sent to the server.
   */
  readonly isEntity: boolean;
}

// Reusable canonical primitive values.
const ID = 'id-1';
const TS = '2026-06-05T09:15:23Z'; // valid ISO-8601 datetime (UTC `Z`)
const EMAIL = 'jan@acme.com';
const ACTOR = 'jan';
const MESSAGE_ID = '<root-2026@acme.com>';
const GIT_URL = 'git@github.com:acme/backend.git';
const SENDER = 'Jan Mikes <jan@acme.com>';

// --- Entities (PROJECT.md §5: the stored shapes) ---------------------------------------------

const projectValid: Record<string, unknown> = { id: ID, name: 'Acme', token_hash: 'hash-abc' };

const threadValid: Record<string, unknown> = {
  id: ID,
  project_id: ID,
  mailbox_address: EMAIL,
  root_message_id: MESSAGE_ID,
  subject: 'Quarterly report',
  snippet: 'Could you send the latest numbers?',
  sender: SENDER,
  last_message_at: TS,
  updated_at: TS,
};

const taskValid: Record<string, unknown> = {
  id: ID,
  thread_id: ID,
  state: 'needs-reply',
  deadline: TS,
  follow_up_at: null,
  importance: 'normal',
  updated_at: TS,
};

const taskTransitionValid: Record<string, unknown> = {
  id: ID,
  task_id: ID,
  from: 'drafted',
  to: 'waiting',
  actor: ACTOR,
  at: TS,
};

const promiseValid: Record<string, unknown> = {
  id: ID,
  thread_id: ID,
  direction: 'my-promise',
  text: 'Send the signed contract',
  due_at: TS,
  due_raw: 'by Friday',
  status: 'open',
  actor: ACTOR,
  created_at: TS,
};

const noteValid: Record<string, unknown> = {
  id: ID,
  thread_id: ID,
  author: ACTOR,
  body: 'Remember they prefer a phone call.',
  at: TS,
};

const repoPointerValid: Record<string, unknown> = {
  id: ID,
  project_id: ID,
  name: 'backend',
  git_url: GIT_URL,
};

const localRepoConfigValid: Record<string, unknown> = {
  repo_pointer_id: ID,
  local_path: '/Users/jan/code/backend',
  active_pull: false,
};

const draftMetaValid: Record<string, unknown> = {
  id: ID,
  thread_id: ID,
  version: 0,
  model: 'opus',
  author: ACTOR,
  at: TS,
};

const lockValid: Record<string, unknown> = {
  thread_id: ID,
  locked_by: ACTOR,
  locked_at: TS,
  expires_at: TS,
};

const toneFileValid: Record<string, unknown> = {
  project_id: ID,
  scope: 'project',
  path: 'project/acme.md',
  content: 'Keep replies short and direct.',
  version_hash: 'vh-1',
  updated_by: ACTOR,
  updated_at: TS,
};

const learningEntryValid: Record<string, unknown> = {
  id: ID,
  project_id: ID,
  scope: 'contact',
  summary: 'Prefer a warmer sign-off with this contact.',
  applied_at: TS,
  reverted_at: null,
};

// --- Server-bound request DTOs (api.ts) ------------------------------------------------------

const pairRequestValid: Record<string, unknown> = { project_id: ID, token: 'plaintext-secret' };

const upsertThreadRequestValid: Record<string, unknown> = {
  project_id: ID,
  mailbox_address: EMAIL,
  root_message_id: MESSAGE_ID,
  subject: 'Quarterly report',
  snippet: 'Could you send the latest numbers?',
  sender: SENDER,
  last_message_at: TS,
};

const createTaskRequestValid: Record<string, unknown> = {
  thread_id: ID,
  state: 'needs-reply',
  deadline: null,
  follow_up_at: null,
  importance: 'normal',
};

const updateTaskRequestValid: Record<string, unknown> = { importance: 'high' };

const createTaskTransitionRequestValid: Record<string, unknown> = {
  to: 'waiting',
  actor: ACTOR,
  expected_from: 'drafted',
};

const createPromiseRequestValid: Record<string, unknown> = {
  thread_id: ID,
  direction: 'they-asked',
  text: 'Please review the PR',
  due_at: null,
  due_raw: 'by end of week',
  status: 'open',
  actor: ACTOR,
};

const updatePromiseRequestValid: Record<string, unknown> = { status: 'fulfilled' };

const createNoteRequestValid: Record<string, unknown> = {
  thread_id: ID,
  author: ACTOR,
  body: 'Follow up after the call.',
};

const createRepoPointerRequestValid: Record<string, unknown> = {
  project_id: ID,
  name: 'backend',
  git_url: GIT_URL,
};

const createDraftMetaRequestValid: Record<string, unknown> = {
  thread_id: ID,
  version: 1,
  model: 'opus',
  author: ACTOR,
};

const acquireLockRequestValid: Record<string, unknown> = {
  thread_id: ID,
  locked_by: ACTOR,
  ttl_seconds: 1800,
};

const refreshLockRequestValid: Record<string, unknown> = {
  thread_id: ID,
  locked_by: ACTOR,
  ttl_seconds: 1800,
};

const releaseLockRequestValid: Record<string, unknown> = { thread_id: ID, locked_by: ACTOR };

const digestMetadataRequestValid: Record<string, unknown> = {
  project_id: ID,
  window_start: TS,
  window_end: TS,
};

const putToneFileRequestValid: Record<string, unknown> = {
  project_id: ID,
  scope: 'mailbox',
  path: 'mailbox/acme.md',
  content: 'Use the team voice here.',
  version_hash: 'vh-2',
  updated_by: ACTOR,
  updated_at: TS,
};

const createLearningEntryRequestValid: Record<string, unknown> = {
  project_id: ID,
  scope: 'project',
  summary: 'Stopped using exclamation marks.',
};

const revertLearningEntryRequestValid: Record<string, unknown> = {};

/**
 * Every strict object contract in the package: the 12 stored entities + the server-bound request
 * DTOs. The privacy suite iterates this so the "no body / no forbidden key" guarantee is proven
 * exhaustively, and the round-trip suite reuses the canonical `valid` payloads.
 */
export const STRICT_CONTRACTS: ContractCase[] = [
  // Entities ----------------------------------------------------------------------------------
  {
    name: 'ProjectSchema',
    schema: ProjectSchema,
    shapeKeys: Object.keys(ProjectSchema.shape),
    valid: projectValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'ThreadSchema',
    schema: ThreadSchema,
    shapeKeys: Object.keys(ThreadSchema.shape),
    valid: threadValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'TaskSchema',
    schema: TaskSchema,
    shapeKeys: Object.keys(TaskSchema.shape),
    valid: taskValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'TaskTransitionSchema',
    schema: TaskTransitionSchema,
    shapeKeys: Object.keys(TaskTransitionSchema.shape),
    valid: taskTransitionValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'PromiseSchema',
    schema: PromiseSchema,
    shapeKeys: Object.keys(PromiseSchema.shape),
    valid: promiseValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'NoteSchema',
    schema: NoteSchema,
    shapeKeys: Object.keys(NoteSchema.shape),
    valid: noteValid,
    allowsBody: true, // SANCTIONED: a user-written note body (PROJECT.md §5).
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'RepoPointerSchema',
    schema: RepoPointerSchema,
    shapeKeys: Object.keys(RepoPointerSchema.shape),
    valid: repoPointerValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'LocalRepoConfigSchema',
    schema: LocalRepoConfigSchema,
    shapeKeys: Object.keys(LocalRepoConfigSchema.shape),
    valid: localRepoConfigValid,
    allowsBody: false,
    allowsContent: false,
    // Machine-local config, never sent to the server — not a §5 metadata-service entity.
    isEntity: false,
  },
  {
    name: 'DraftMetaSchema',
    schema: DraftMetaSchema,
    shapeKeys: Object.keys(DraftMetaSchema.shape),
    valid: draftMetaValid,
    allowsBody: false, // CRITICAL: draft metadata only, NEVER a draft body (PROJECT.md §5).
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'LockSchema',
    schema: LockSchema,
    shapeKeys: Object.keys(LockSchema.shape),
    valid: lockValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  {
    name: 'ToneFileSchema',
    schema: ToneFileSchema,
    shapeKeys: Object.keys(ToneFileSchema.shape),
    valid: toneFileValid,
    allowsBody: false,
    allowsContent: true, // SANCTIONED: derived tone-memory content (PROJECT.md §5).
    isEntity: true,
  },
  {
    name: 'LearningEntrySchema',
    schema: LearningEntrySchema,
    shapeKeys: Object.keys(LearningEntrySchema.shape),
    valid: learningEntryValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: true,
  },
  // Request DTOs ------------------------------------------------------------------------------
  {
    name: 'PairRequestSchema',
    schema: PairRequestSchema,
    shapeKeys: Object.keys(PairRequestSchema.shape),
    valid: pairRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'UpsertThreadRequestSchema',
    schema: UpsertThreadRequestSchema,
    shapeKeys: Object.keys(UpsertThreadRequestSchema.shape),
    valid: upsertThreadRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreateTaskRequestSchema',
    schema: CreateTaskRequestSchema,
    shapeKeys: Object.keys(CreateTaskRequestSchema.shape),
    valid: createTaskRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'UpdateTaskRequestSchema',
    schema: UpdateTaskRequestSchema,
    shapeKeys: Object.keys(UpdateTaskRequestSchema.shape),
    valid: updateTaskRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreateTaskTransitionRequestSchema',
    schema: CreateTaskTransitionRequestSchema,
    shapeKeys: Object.keys(CreateTaskTransitionRequestSchema.shape),
    valid: createTaskTransitionRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreatePromiseRequestSchema',
    schema: CreatePromiseRequestSchema,
    shapeKeys: Object.keys(CreatePromiseRequestSchema.shape),
    valid: createPromiseRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'UpdatePromiseRequestSchema',
    schema: UpdatePromiseRequestSchema,
    shapeKeys: Object.keys(UpdatePromiseRequestSchema.shape),
    valid: updatePromiseRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreateNoteRequestSchema',
    schema: CreateNoteRequestSchema,
    shapeKeys: Object.keys(CreateNoteRequestSchema.shape),
    valid: createNoteRequestValid,
    allowsBody: true, // SANCTIONED: a user note (PROJECT.md §5).
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreateRepoPointerRequestSchema',
    schema: CreateRepoPointerRequestSchema,
    shapeKeys: Object.keys(CreateRepoPointerRequestSchema.shape),
    valid: createRepoPointerRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'CreateDraftMetaRequestSchema',
    schema: CreateDraftMetaRequestSchema,
    shapeKeys: Object.keys(CreateDraftMetaRequestSchema.shape),
    valid: createDraftMetaRequestValid,
    allowsBody: false, // CRITICAL: never a draft body on the wire.
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'AcquireLockRequestSchema',
    schema: AcquireLockRequestSchema,
    shapeKeys: Object.keys(AcquireLockRequestSchema.shape),
    valid: acquireLockRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'RefreshLockRequestSchema',
    schema: RefreshLockRequestSchema,
    shapeKeys: Object.keys(RefreshLockRequestSchema.shape),
    valid: refreshLockRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'ReleaseLockRequestSchema',
    schema: ReleaseLockRequestSchema,
    shapeKeys: Object.keys(ReleaseLockRequestSchema.shape),
    valid: releaseLockRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'DigestMetadataRequestSchema',
    schema: DigestMetadataRequestSchema,
    shapeKeys: Object.keys(DigestMetadataRequestSchema.shape),
    valid: digestMetadataRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'PutToneFileRequestSchema',
    schema: PutToneFileRequestSchema,
    shapeKeys: Object.keys(PutToneFileRequestSchema.shape),
    valid: putToneFileRequestValid,
    allowsBody: false,
    allowsContent: true, // SANCTIONED: tone-memory content (PROJECT.md §5).
    isEntity: false,
  },
  {
    name: 'CreateLearningEntryRequestSchema',
    schema: CreateLearningEntryRequestSchema,
    shapeKeys: Object.keys(CreateLearningEntryRequestSchema.shape),
    valid: createLearningEntryRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
  {
    name: 'RevertLearningEntryRequestSchema',
    schema: RevertLearningEntryRequestSchema,
    shapeKeys: Object.keys(RevertLearningEntryRequestSchema.shape),
    valid: revertLearningEntryRequestValid,
    allowsBody: false,
    allowsContent: false,
    isEntity: false,
  },
];
