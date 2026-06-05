/**
 * The "thread detail" read model for the split work surface LEFT pane (PROJECT.md §11; PLAN.md §7
 * Phase 7b, decision D31). This is the body-free shape the LOCAL backend assembles for one open
 * thread and the React frontend renders: ordered message metadata + Claude's pinned summary + a
 * repo-freshness indicator + the current lock (presence).
 *
 * PRIVACY (Golden rule #3 — body-free BY CONSTRUCTION): every schema here is a `z.strictObject`
 * carrying ONLY metadata + the sanctioned message-derived fields (subject / snippet / sender / date).
 * There is deliberately NO message-body, draft-body, `.eml`, or attachment field — a smuggled
 * `body`/`draftBody`/`content`/`html` key fails `parse()`. The RENDERED message body is fetched over a
 * SEPARATE local-only hop (`GET …/messages/:id/body`), parsed from the on-disk `.eml`, and is NEVER
 * part of this (or any shared/server-bound) DTO.
 *
 * The draft body + refine transcript are likewise NOT here — they are LOCAL-only backend types
 * (`drafts/types.ts`), never a shared server-bound contract (D31).
 */
import { z } from 'zod';
import { LockSchema } from './entities';
import {
  IdSchema,
  IsoDateTimeSchema,
  MessageIdSchema,
  SenderSchema,
  SnippetSchema,
} from './primitives';

/**
 * Repo-freshness indicator for the left pane (PROJECT.md §10/§11 "repo-freshness indicator"). For a
 * git-URL mirror this reflects whether the read-only clone is up to date; for a local-path repo it is
 * `fresh`. `null` (on {@link ThreadDetailSchema}) means no repo is linked / freshness is not yet
 * computed — repo pointers are wired in Phase 8, so v1 leaves this a structural placeholder.
 */
export const REPO_FRESHNESS_STATES = ['fresh', 'stale', 'unknown'] as const;
export const RepoFreshnessSchema = z.enum(REPO_FRESHNESS_STATES);
export type RepoFreshness = z.infer<typeof RepoFreshnessSchema>;

/**
 * One message's METADATA in a thread (oldest → newest in {@link ThreadDetailSchema}). Strict + body
 * free per D20: `messageId` (the RFC Message-ID or a synthetic JWZ id — the key the body hop uses),
 * plus the sanctioned `sender`/`date`/`subject`/`snippet`. NO body field — the rendered body comes
 * from the separate local `…/messages/:messageId/body` endpoint.
 */
export const ThreadMessageMetaSchema = z.strictObject({
  messageId: MessageIdSchema,
  sender: SenderSchema.nullable(),
  date: IsoDateTimeSchema.nullable(),
  subject: z.string().nullable(),
  snippet: SnippetSchema.nullable(),
});
export type ThreadMessageMeta = z.infer<typeof ThreadMessageMetaSchema>;

/**
 * The full thread-detail read model for ONE thread. `messages` is ordered oldest→newest;
 * `pinnedSummary` is Claude's summary (Sonnet) shown pinned at the top, or `null` when none is
 * available; `repoFreshness` is the indicator (or `null` — see {@link RepoFreshnessSchema}); `lock`
 * is the current holder for the presence indicator (or `null` when the thread is unlocked).
 *
 * It is a LOCAL hop (backend → frontend); it never reaches the metadata server, but it is still
 * strict + body-free by construction (only metadata + the sanctioned subject/snippet/sender).
 */
export const ThreadDetailSchema = z.strictObject({
  threadId: IdSchema,
  subject: z.string().nullable(),
  sender: SenderSchema.nullable(),
  snippet: SnippetSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema.nullable(),
  messages: z.array(ThreadMessageMetaSchema),
  pinnedSummary: z.string().nullable(),
  repoFreshness: RepoFreshnessSchema.nullable(),
  lock: LockSchema.nullable(),
});
export type ThreadDetail = z.infer<typeof ThreadDetailSchema>;
