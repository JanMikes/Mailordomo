/**
 * THE PRIVACY BOUNDARY — Golden rule #3 / PROJECT.md §5.
 *
 * "Email bodies never leave the local machine. Only metadata + subject + snippet + sender go to
 * the server." Raw `.eml`, email bodies, draft bodies, refine-chat transcripts, and attachment
 * content are LOCAL-ONLY and must never appear in any payload sent to the metadata service.
 *
 * HOW THIS IS ENFORCED IN THE SCHEMAS (not by convention — by construction):
 *   Every server-bound payload schema in this package is a zod `strictObject`. Strict objects
 *   REJECT any key that is not explicitly declared. Because none of these schemas declare an
 *   email-body / draft-body / `.eml` / attachment-content field, a payload carrying one fails
 *   validation before it can ever be serialized to the wire. The rejection comes from `.strict()`
 *   / `z.strictObject`, NOT from the list below — the list is documentation and a test target.
 *
 * THE TWO SANCTIONED, NON-BODY EXCEPTIONS (PROJECT.md §5) — both are declared fields, so they pass:
 *   1. `Note.body`     — a USER-written per-thread note. This is the user's own text, not email
 *                        content; it legitimately lives on the server.
 *   2. `ToneFile.content` — DERIVED voice/style memory the user opts into syncing. Not raw inbound
 *                        email. (Where it quotes a phrasing, that is memory, not a live message.)
 *   Plus the bounded `snippet` (≤ {@link import('./primitives').SNIPPET_MAX_LENGTH} chars) and
 *   `subject`/`sender` — the explicit shared-digest surface.
 *
 * Anywhere OTHER than `Note`, a `body` key is rejected; anywhere OTHER than `ToneFile`, a
 * `content` key is rejected — automatically, because those schemas don't declare them and are
 * strict.
 */

/**
 * Representative body-like keys that must NEVER appear in a server-bound payload. This is NOT the
 * enforcement mechanism (strict-object validation is) — it exists so the privacy test suite can
 * assert, for each strict server DTO, that injecting any of these keys fails validation.
 *
 * Deliberately excludes bare `body` and `content`, which are legitimate fields on `Note` and
 * `ToneFile` respectively; those are proven rejected on OTHER schemas by the strict-object check.
 */
export const FORBIDDEN_SERVER_PAYLOAD_KEYS = [
  'eml',
  'emlContent',
  'rawMessage',
  'raw_message',
  'messageBody',
  'message_body',
  'emailBody',
  'email_body',
  'draftBody',
  'draft_body',
  'bodyHtml',
  'body_html',
  'bodyText',
  'body_text',
  'attachment',
  'attachments',
  'attachmentContent',
  'attachment_content',
  // Refine-chat transcripts are local-only per PROJECT.md §5 — never a server payload.
  'transcript',
  'transcripts',
  'refineChat',
  'refine_chat',
  'refineChatTranscript',
  'refine_chat_transcript',
] as const;

export type ForbiddenServerPayloadKey = (typeof FORBIDDEN_SERVER_PAYLOAD_KEYS)[number];
