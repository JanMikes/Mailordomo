/**
 * The REAL {@link ImapClient} (+ {@link ImapAppendClient}) — a thin adapter over an `ImapFlow`
 * connection. It is the only file in the sync stack that imports imapflow; everything else depends
 * on the injected interface, so tests never touch this.
 *
 * Design points baked in (PROJECT.md §4):
 *  - ONE `ImapFlow` per watched mailbox (the caller constructs one adapter per mailbox).
 *  - `maxIdleTime` is set comfortably under the ~29-min RFC ceiling so IDLE self-renews.
 *  - `References` is pulled from the raw header line and parsed with the SAME parser the threading
 *    engine uses, so cache + threading agree.
 */
import { ImapFlow } from 'imapflow';
import type {
  ExistsEvent,
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  MailboxObject,
  MessageEnvelopeObject,
} from 'imapflow';
import { parseMessageIds } from '../threading/jwz';
import type {
  ImapAppendClient,
  ImapClient,
  ImapEnvelope,
  ImapExistsEvent,
  ImapFetchedMessage,
  ImapFetchQuery,
  ImapFolderInfo,
  ImapMailboxState,
  Unsubscribe,
} from './types';

/** Default IDLE renewal window (< 29 min RFC ceiling) so IDLE self-renews without dropping. */
export const DEFAULT_MAX_IDLE_MS = 9 * 60 * 1000;

export interface ImapFlowClientConfig {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly auth: { readonly user: string; readonly pass?: string; readonly accessToken?: string };
  /** IDLE self-renew window in ms. Default {@link DEFAULT_MAX_IDLE_MS}. */
  readonly maxIdleTimeMs?: number;
  readonly logger?: ImapFlowOptions['logger'];
  /** Use QRESYNC instead of CONDSTORE when the server supports it. */
  readonly qresync?: boolean;
}

function parseReferencesHeader(headers: Buffer): string[] | undefined {
  const text = headers.toString('utf8');
  // Match the (possibly folded) References header line, case-insensitively.
  const match = /^references:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im.exec(text);
  if (!match) return undefined;
  return parseMessageIds(match[1] ?? '');
}

function mapEnvelope(envelope: MessageEnvelopeObject): ImapEnvelope {
  return {
    messageId: envelope.messageId,
    inReplyTo: envelope.inReplyTo,
    subject: envelope.subject,
    date: envelope.date,
    from: envelope.from?.map((address) => ({ name: address.name, address: address.address })),
  };
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function mapFetched(message: FetchMessageObject): ImapFetchedMessage {
  return {
    uid: message.uid,
    modseq: message.modseq,
    flags: message.flags ?? new Set<string>(),
    internalDate: toDate(message.internalDate),
    size: message.size,
    envelope: message.envelope ? mapEnvelope(message.envelope) : undefined,
    references: message.headers ? parseReferencesHeader(message.headers) : undefined,
    source: message.source,
  };
}

export class ImapFlowAdapter implements ImapClient, ImapAppendClient {
  private readonly flow: ImapFlow;

  constructor(flow: ImapFlow) {
    this.flow = flow;
  }

  /** Escape hatch for the connection layer / send path that need the raw ImapFlow instance. */
  get raw(): ImapFlow {
    return this.flow;
  }

  connect(): Promise<void> {
    return this.flow.connect();
  }

  logout(): Promise<void> {
    return this.flow.logout();
  }

  close(): void {
    this.flow.close();
  }

  async list(): Promise<readonly ImapFolderInfo[]> {
    const folders = await this.flow.list();
    return folders.map((folder) => ({
      path: folder.path,
      specialUse: folder.specialUse,
      flags: folder.flags,
    }));
  }

  async openMailbox(path: string, options?: { readOnly?: boolean }): Promise<ImapMailboxState> {
    const mailbox: MailboxObject = await this.flow.mailboxOpen(path, {
      readOnly: options?.readOnly ?? true,
    });
    return {
      path: mailbox.path,
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.uidNext,
      highestModseq: mailbox.highestModseq,
      exists: mailbox.exists,
      readOnly: mailbox.readOnly ?? false,
    };
  }

  async *fetchByUid(range: string, query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    const fetchQuery: FetchQueryObject = {
      uid: true,
      envelope: query.envelope ?? false,
      flags: query.flags ?? false,
      internalDate: query.internalDate ?? false,
      size: query.size ?? false,
      source: query.source ?? false,
      headers: query.references ? ['references'] : false,
    };
    const options: FetchOptions = { uid: true };
    if (query.changedSince !== undefined) options.changedSince = query.changedSince;

    for await (const message of this.flow.fetch(range, fetchQuery, options)) {
      yield mapFetched(message);
    }
  }

  append(
    path: string,
    raw: Buffer | string,
    flags?: readonly string[],
  ): Promise<{ uid?: number; uidValidity?: bigint } | null> {
    return this.flow
      .append(path, raw, flags ? [...flags] : undefined)
      .then((result) => (result ? { uid: result.uid, uidValidity: result.uidValidity } : null));
  }

  onClose(listener: () => void): Unsubscribe {
    this.flow.on('close', listener);
    return () => {
      this.flow.removeListener('close', listener);
    };
  }

  onError(listener: (error: Error) => void): Unsubscribe {
    this.flow.on('error', listener);
    return () => {
      this.flow.removeListener('error', listener);
    };
  }

  onExists(listener: (event: ImapExistsEvent) => void): Unsubscribe {
    const handler = (event: ExistsEvent): void => {
      listener({ path: event.path, count: event.count, prevCount: event.prevCount });
    };
    this.flow.on('exists', handler);
    return () => {
      this.flow.removeListener('exists', handler);
    };
  }
}

/** Construct a real imapflow-backed client for one mailbox. */
export function createImapFlowClient(config: ImapFlowClientConfig): ImapFlowAdapter {
  const flow = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure ?? true,
    auth: config.auth.accessToken
      ? { user: config.auth.user, accessToken: config.auth.accessToken }
      : { user: config.auth.user, pass: config.auth.pass },
    maxIdleTime: config.maxIdleTimeMs ?? DEFAULT_MAX_IDLE_MS,
    qresync: config.qresync ?? false,
    logger: config.logger ?? false,
  });
  return new ImapFlowAdapter(flow);
}
