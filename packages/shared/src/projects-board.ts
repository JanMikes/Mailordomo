/**
 * The "Projects board" read model (PROJECT.md §11; PLAN.md §7 Phase 7c, decision D32).
 *
 * This is the shape the LOCAL backend assembles for the all-projects + per-project views and the
 * classic 3-pane fallback's left list: each project's threads GROUPED BY task state, in the canonical
 * state-machine order (needs-reply → drafted → waiting → follow-up → done). It is single-project in
 * v1 (one configured project) but the array-of-projects shape generalizes to N without a rewrite.
 *
 * PRIVACY (Golden rule #3 — body-free BY CONSTRUCTION): every schema here is a `z.strictObject` (D20)
 * carrying ONLY metadata + the two sanctioned message-derived fields (subject / snippet / sender). It
 * is a backend → frontend LOCAL hop (never sent to the metadata server), but it deliberately has NO
 * message-body / draft-body / `.eml` / attachment field — a smuggled `body`/`draftBody`/`content` key
 * fails `parse()`, exactly as on the server boundary. The board's cards mirror the Today do-next
 * cards' body-free discipline.
 */
import { z } from 'zod';
import { ImportanceSchema, PromiseDirectionSchema, TaskStateSchema, TASK_STATES } from './enums';
import { IdSchema, IsoDateTimeSchema, SenderSchema, SnippetSchema } from './primitives';
import type { TaskState } from './enums';

/**
 * One thread's body-free card on the projects board / 3-pane middle list. METADATA ONLY:
 * subject/snippet/sender are the sanctioned message-derived fields; everything else is task/promise
 * metadata. `hasDraftReady` reflects draft METADATA existence only (never the draft body — Golden
 * rule #3); `promiseDirections` is the unique set of 3-way directions present on the thread (drives
 * the color dots, like the Today card).
 */
export const BoardThreadCardSchema = z.strictObject({
  threadId: IdSchema,
  subject: z.string().nullable(),
  snippet: SnippetSchema.nullable(),
  sender: SenderSchema.nullable(),
  state: TaskStateSchema,
  importance: ImportanceSchema,
  deadline: IsoDateTimeSchema.nullable(),
  followUpAt: IsoDateTimeSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema.nullable(),
  hasDraftReady: z.boolean(),
  /** Unique set of promise directions present on this thread (drives the color dots). */
  promiseDirections: z.array(PromiseDirectionSchema),
});
export type BoardThreadCard = z.infer<typeof BoardThreadCardSchema>;

/**
 * A `Record<TaskState, T>` schema with one key per canonical {@link TASK_STATES} value (no more, no
 * less — strict). Used for the per-state `groups` (thread cards) and `counts` (numbers); an empty
 * group is the empty array / a zero count, never an absent key, so the frontend can iterate the
 * states in order without presence checks.
 */
function byStateSchema<T extends z.ZodTypeAny>(value: T): z.ZodObject<Record<TaskState, T>> {
  const shape = Object.fromEntries(TASK_STATES.map((state) => [state, value])) as Record<
    TaskState,
    T
  >;
  return z.strictObject(shape);
}

/** Per-state buckets of thread cards (every {@link TASK_STATES} key present; empty arrays allowed). */
export const BoardGroupsSchema = byStateSchema(z.array(BoardThreadCardSchema));
export type BoardGroups = z.infer<typeof BoardGroupsSchema>;

/** Per-state thread counts (every {@link TASK_STATES} key present; mirrors {@link BoardGroupsSchema}). */
export const BoardCountsSchema = byStateSchema(z.number().int().nonnegative());
export type BoardCounts = z.infer<typeof BoardCountsSchema>;

/**
 * One project's section on the board: its identity (+ resolved display `name`, null when the metadata
 * service could not be reached to resolve it — D32) and its threads grouped/counted by task state.
 */
export const ProjectBoardEntrySchema = z.strictObject({
  projectId: IdSchema,
  projectName: z.string().nullable(),
  groups: BoardGroupsSchema,
  counts: BoardCountsSchema,
});
export type ProjectBoardEntry = z.infer<typeof ProjectBoardEntrySchema>;

/**
 * The full projects-board read model (PROJECT.md §11). `generatedAt` is the backend's wall clock at
 * assembly; `projects` is every project section (one in v1 — D32). A LOCAL hop (backend → frontend),
 * strict + body-free by construction.
 */
export const ProjectsBoardSchema = z.strictObject({
  generatedAt: IsoDateTimeSchema,
  projects: z.array(ProjectBoardEntrySchema),
});
export type ProjectsBoard = z.infer<typeof ProjectsBoardSchema>;
