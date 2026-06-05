/**
 * Morning-digest read models (PROJECT.md §9, §5; PLAN.md §9 #10/#11).
 *
 * These are the SHARED metadata the digest endpoint returns. Crucially, the server only ever
 * supplies metadata + the sanctioned subject/snippet/sender; the local app synthesizes the actual
 * digest PROSE locally (my-mailbox content never leaves the machine). The "what Simona handled"
 * section is built purely from actor-attributed transitions here. Every shape is strict and
 * body-free; the only message-derived text is the sanctioned subject/snippet/sender.
 */
import { z } from 'zod';
import {
  ActorSchema,
  ImportanceSchema,
  ModelAliasSchema,
  PromiseDirectionSchema,
  PromiseStatusSchema,
  TaskStateSchema,
} from './enums';
import { IdSchema, IsoDateTimeSchema, SenderSchema, SnippetSchema } from './primitives';

/** "What needs you today" row: a thread surfaced with its sanctioned shared fields + task state. */
export const DigestThreadRefSchema = z.strictObject({
  thread_id: IdSchema,
  project_id: IdSchema,
  subject: z.string(),
  snippet: SnippetSchema,
  sender: SenderSchema,
  state: TaskStateSchema,
  importance: ImportanceSchema,
  deadline: IsoDateTimeSchema.nullable(),
});
export type DigestThreadRef = z.infer<typeof DigestThreadRefSchema>;

/**
 * "What Simona handled" row: an actor-attributed transition with enough thread context (subject)
 * to render a line. The `actor` is what lets the digest attribute the action.
 */
export const DigestTransitionEntrySchema = z.strictObject({
  task_id: IdSchema,
  thread_id: IdSchema,
  subject: z.string(),
  from: TaskStateSchema,
  to: TaskStateSchema,
  actor: ActorSchema,
  at: IsoDateTimeSchema,
});
export type DigestTransitionEntry = z.infer<typeof DigestTransitionEntrySchema>;

/** "Promises due" row: a promise with thread context, for the 3-way "due today/overdue" section. */
export const DigestPromiseEntrySchema = z.strictObject({
  promise_id: IdSchema,
  thread_id: IdSchema,
  subject: z.string(),
  direction: PromiseDirectionSchema,
  text: z.string().min(1),
  due_at: IsoDateTimeSchema.nullable(),
  status: PromiseStatusSchema,
});
export type DigestPromiseEntry = z.infer<typeof DigestPromiseEntrySchema>;

/** "What Claude drafted" row: draft METADATA only (no body), with thread context. */
export const DigestDraftEntrySchema = z.strictObject({
  thread_id: IdSchema,
  subject: z.string(),
  model: ModelAliasSchema,
  author: ActorSchema,
  at: IsoDateTimeSchema,
});
export type DigestDraftEntry = z.infer<typeof DigestDraftEntrySchema>;

/**
 * The full digest metadata payload for a time window — the four sections the local synthesizer
 * turns into prose. Body-free by construction (strict + only sanctioned fields).
 */
export const DigestMetadataSchema = z.strictObject({
  project_id: IdSchema,
  generated_at: IsoDateTimeSchema,
  window_start: IsoDateTimeSchema,
  window_end: IsoDateTimeSchema,
  needs_you: z.array(DigestThreadRefSchema),
  promises_due: z.array(DigestPromiseEntrySchema),
  handled: z.array(DigestTransitionEntrySchema),
  drafted: z.array(DigestDraftEntrySchema),
});
export type DigestMetadata = z.infer<typeof DigestMetadataSchema>;
