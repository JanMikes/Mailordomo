/**
 * Real implementations of the send-path seams (`MessageComposer` / `MailTransport` / `SentFiler`)
 * backed by nodemailer. Kept OUT of the package's public barrel so the disposable-cache build never
 * pulls nodemailer in; it is wired only where a send is actually performed (Phase 9), and even then
 * the transport is STUBBED in tests so nothing is ever transmitted from CI.
 *
 * Like `send.ts`, this file is under `smtp/**` and therefore must never import the daemon
 * (ESLint-enforced). It composes the raw MIME ONCE so the bytes that go over SMTP are byte-identical
 * to the copy appended to the Sent folder (matching Message-ID + threading headers).
 */
import { randomUUID } from 'node:crypto';
import { createTransport } from 'nodemailer';
// Explicit `/index.js` (not the bare directory) so the runnable ESM server bundle resolves this deep
// import under Node's ESM loader, which rejects CJS-style directory imports (ERR_UNSUPPORTED_DIR_IMPORT).
import NodemailerMailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { ImapAppendClient } from '../imap/types';
import type {
  ComposedMime,
  MailTransport,
  MessageComposer,
  OutgoingMessage,
  SentFiler,
} from './send';

function domainOf(from: string): string {
  const at = from.lastIndexOf('@');
  if (at === -1) return 'localhost';
  const domain = from
    .slice(at + 1)
    .replace(/[>\s].*$/, '')
    .trim();
  return domain.length > 0 ? domain : 'localhost';
}

/** A stable RFC Message-ID for a new outgoing message, scoped to the sender's domain. */
export function generateMessageId(from: string): string {
  return `<${randomUUID()}@${domainOf(from)}>`;
}

async function composeMime(message: OutgoingMessage): Promise<ComposedMime> {
  const messageId = message.messageId ?? generateMessageId(message.from);
  const composer = new NodemailerMailComposer({
    from: message.from,
    to: [...message.to],
    cc: message.cc ? [...message.cc] : undefined,
    bcc: message.bcc ? [...message.bcc] : undefined,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo ?? undefined,
    references: message.references ? [...message.references] : undefined,
    messageId,
    headers: message.headers ? { ...message.headers } : undefined,
  });
  const raw = await composer.compile().build();
  return { raw, messageId, envelope: { from: message.from, to: [...message.to] } };
}

/** A nodemailer-backed composer (sets threading headers + a captured Message-ID). */
export function createNodemailerComposer(): MessageComposer {
  return { compose: composeMime };
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly auth?: { readonly user: string; readonly pass?: string };
}

/**
 * A nodemailer SMTP transport. Sends the pre-composed raw MIME (so the Sent copy matches exactly)
 * and reports back the Message-ID we set. This is the single real transmission primitive — only ever
 * invoked from an explicit user action.
 */
export function createNodemailerTransport(config: SmtpConfig): MailTransport {
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? true,
    auth: config.auth ? { user: config.auth.user, pass: config.auth.pass } : undefined,
  });
  return {
    async send(composed: ComposedMime) {
      const info = await transporter.sendMail({
        envelope: { from: composed.envelope.from, to: composed.envelope.to },
        raw: composed.raw,
      });
      return { messageId: composed.messageId, response: info.response };
    },
  };
}

/** Files raw MIME into a SPECIAL-USE folder (Sent/Drafts) via IMAP APPEND. */
export function createImapSentFiler(client: ImapAppendClient): SentFiler {
  return {
    append: (folder, raw, flags) => client.append(folder, raw, flags),
  };
}
