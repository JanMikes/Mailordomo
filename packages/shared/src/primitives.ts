/**
 * Common primitive schemas shared by every entity and API contract.
 *
 * Conventions for the whole package:
 * - Field names are snake_case to match the entity definitions in PROJECT.md §5 verbatim
 *   (`project_id`, `due_at`, `version_hash`, …) so the wire shape mirrors the spec.
 * - Datetimes are ISO-8601 strings (absolute, with timezone). Natural-language / relative
 *   deadlines ("by Friday") are carried separately as raw strings (see Promise) and resolved by
 *   the Phase 5 reconciler; the contract only ever stores the resolved absolute time.
 */
import { z } from 'zod';

/**
 * Identifier schema. Ids are opaque non-empty strings (e.g. ULIDs/UUIDs generated server-side).
 *
 * NOTE (possible later enhancement): these could become zod branded types
 * (`z.string().brand<'ThreadId'>()`) to stop a `ThreadId` being passed where a `ProjectId` is
 * expected. We deliberately keep plain `string` aliases for Phase 1 — branding is additive and can
 * be introduced without changing the wire format.
 */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

// Semantic id aliases — pure documentation today (all resolve to `string`); the seam for branding.
export type ProjectId = Id;
export type ThreadId = Id;
export type TaskId = Id;
export type PromiseId = Id;
export type NoteId = Id;
export type RepoPointerId = Id;
export type DraftId = Id;
export type LearningEntryId = Id;

/**
 * ISO-8601 datetime string. `offset: true` accepts both `Z` (UTC) and explicit offsets
 * (`+02:00`) — Europe/Prague is UTC+1/+2 and the server may normalize to UTC.
 */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** RFC-5322 email address (used for mailbox addresses). */
export const EmailAddressSchema = z.email();
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

/**
 * Maximum length of a shared snippet. PROJECT.md §5 bounds it at ~200 chars: a snippet is a
 * sanctioned non-body exception, so the bound is load-bearing — it caps how much message text can
 * ever reach the server.
 */
export const SNIPPET_MAX_LENGTH = 200;

/** Bounded preview text — one of the two sanctioned non-body fields that may reach the server. */
export const SnippetSchema = z.string().max(SNIPPET_MAX_LENGTH);
export type Snippet = z.infer<typeof SnippetSchema>;

/**
 * Sender as it appears on a thread for the shared digest. A From header is freeform
 * ("Display Name <addr@host>"), so this is a bounded string rather than a strict email address.
 * Capped at the RFC-5322 header-line length so it cannot smuggle bulk text to the server.
 */
export const SenderSchema = z.string().min(1).max(998);
export type Sender = z.infer<typeof SenderSchema>;

/** RFC Message-ID (e.g. `<abc@host>`); the thread root key. */
export const MessageIdSchema = z.string().min(1);
export type MessageId = z.infer<typeof MessageIdSchema>;

/** Content/version hash used for tone-file last-write-wins reconciliation. */
export const HashSchema = z.string().min(1);
export type Hash = z.infer<typeof HashSchema>;
