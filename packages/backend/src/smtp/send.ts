/**
 * SMTP send path — the ONLY place mail is transmitted, and ONLY ever as the result of an explicit
 * user action (Golden rule #1: sending is ALWAYS manual).
 *
 * STRUCTURAL NO-SEND GUARD (PLAN.md §4.6): this module must NOT import anything under `../daemon/**`
 * (and the daemon must not import anything under `../smtp/**`). The boundary is ESLint-enforced so an
 * accidental autonomous-send wiring is a LINT failure, before tests even run. Keep this file free of
 * any daemon reference.
 *
 * What the real send does (PROJECT.md §4): set `In-Reply-To` + `References` from the parent for
 * correct threading, capture the returned `Message-ID`, and `append()` the raw MIME to the Sent
 * folder (Drafts for a saved draft) resolved via SPECIAL-USE flags — never English folder names.
 *
 * Everything here is injectable/stubbable: the composer, the transport, and the IMAP filer are
 * interfaces. The real implementations live in `nodemailer.ts`; the live path is exercised only by
 * the Phase 9 E2E with a STUBBED transport (it never actually sends in tests).
 */
import type { SpecialUseFolders } from '../engines/folder-mapper';

/** Marker retained from the Phase 0 skeleton (referenced by the structural-guard smoke tests). */
export const SEND_MODULE = 'mailordomo-smtp-send' as const;

/** Documents the invariant that a send only ever happens downstream of an explicit user action. */
export function assertManualSendOnly(): typeof SEND_MODULE {
  return SEND_MODULE;
}

/** The parent message a reply threads under. */
export interface ReplyParent {
  readonly messageId: string;
  readonly references?: readonly string[];
}

/**
 * Build `In-Reply-To` + `References` for a reply (PROJECT.md §4). `In-Reply-To` is the parent's
 * Message-ID; `References` is the parent's chain followed by the parent's own Message-ID, de-duped
 * and order-preserving. Pure — unit-testable without any transport.
 */
export function buildReplyHeaders(parent: ReplyParent | null | undefined): {
  inReplyTo: string | null;
  references: string[];
} {
  if (!parent) return { inReplyTo: null, references: [] };
  const references: string[] = [];
  const seen = new Set<string>();
  for (const ref of [...(parent.references ?? []), parent.messageId]) {
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      references.push(ref);
    }
  }
  return { inReplyTo: parent.messageId, references };
}

export interface OutgoingMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly inReplyTo?: string | null;
  readonly references?: readonly string[];
  /** Explicit Message-ID; when omitted the composer generates one (and reports it back). */
  readonly messageId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A fully-composed MIME message: raw bytes + the final Message-ID + the SMTP envelope. */
export interface ComposedMime {
  readonly raw: Buffer;
  readonly messageId: string;
  readonly envelope: { readonly from: string; readonly to: string[] };
}

/** Composes an {@link OutgoingMessage} into raw MIME (sets threading headers + Message-ID). */
export interface MessageComposer {
  compose(message: OutgoingMessage): Promise<ComposedMime>;
}

/** Transmits a composed message over SMTP. The real impl uses nodemailer; tests stub it. */
export interface MailTransport {
  send(composed: ComposedMime): Promise<{ messageId: string; response?: string }>;
}

/** Files a raw MIME copy into an IMAP folder (Sent / Drafts) via APPEND. */
export interface SentFiler {
  append(folder: string, raw: Buffer, flags?: readonly string[]): Promise<unknown>;
}

export interface SendDeps {
  readonly composer: MessageComposer;
  readonly transport: MailTransport;
  /** When present (with a resolved Sent/Drafts folder) the raw MIME is appended after composing. */
  readonly filer?: SentFiler;
  readonly specialUse?: SpecialUseFolders;
}

export interface SendResult {
  readonly messageId: string;
  /** The folder the raw copy was filed into, or `null` if no filer/folder was available. */
  readonly filedTo: string | null;
}

/**
 * Send a reply. This is the ONLY transmission point in the system and is invoked exclusively from an
 * explicit user action (never the daemon — enforced structurally). After sending it files the exact
 * same bytes into the SPECIAL-USE Sent folder, because SMTP does not self-file (except Gmail).
 */
export async function sendReply(
  message: OutgoingMessage,
  parent: ReplyParent | null | undefined,
  deps: SendDeps,
): Promise<SendResult> {
  const headers = buildReplyHeaders(parent);
  const composed = await deps.composer.compose({
    ...message,
    inReplyTo: message.inReplyTo ?? headers.inReplyTo,
    references: message.references ?? headers.references,
  });

  const sent = await deps.transport.send(composed);

  let filedTo: string | null = null;
  const sentFolder = deps.specialUse?.sent;
  if (deps.filer && sentFolder) {
    await deps.filer.append(sentFolder, composed.raw, ['\\Seen']);
    filedTo = sentFolder;
  }
  return { messageId: sent.messageId, filedTo };
}

/**
 * Save a draft: compose and APPEND to the SPECIAL-USE Drafts folder. NEVER transmits — there is no
 * `transport.send` call on this path. Used both for the on-signal draft and the sanctioned
 * overdue-nudge draft (which is filed, ready, and still requires a manual send).
 */
export async function saveDraft(message: OutgoingMessage, deps: SendDeps): Promise<SendResult> {
  const composed = await deps.composer.compose(message);
  let filedTo: string | null = null;
  const draftsFolder = deps.specialUse?.drafts;
  if (deps.filer && draftsFolder) {
    await deps.filer.append(draftsFolder, composed.raw, ['\\Draft']);
    filedTo = draftsFolder;
  }
  return { messageId: composed.messageId, filedTo };
}
