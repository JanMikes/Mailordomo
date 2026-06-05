/**
 * The IMAP injection seam.
 *
 * The sync engine talks to this minimal, fully-typed interface — NOT to imapflow directly. The real
 * adapter (`imapflow-client.ts`) implements it over an `ImapFlow` connection; tests inject a FAKE
 * that implements the same interface, so all delta/sync/reconnect logic is exercisable with NO live
 * server (PLAN.md §5 "fake IMAP surface"). Keeping this file free of any runtime import is what lets
 * the engines depend on the shape without dragging imapflow into pure code.
 */

/** One folder as returned by LIST: path + its SPECIAL-USE flag + the flag set. */
export interface ImapFolderInfo {
  readonly path: string;
  readonly specialUse?: string | undefined;
  readonly flags: ReadonlySet<string>;
}

/** Selected-mailbox state after OPEN — the server side of the sync cursor. */
export interface ImapMailboxState {
  readonly path: string;
  readonly uidValidity: bigint;
  readonly uidNext: number;
  readonly highestModseq?: bigint | undefined;
  readonly exists: number;
  readonly readOnly: boolean;
}

export interface ImapAddress {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
}

/** Parsed envelope (subset of imapflow's `MessageEnvelopeObject`) the cache needs. */
export interface ImapEnvelope {
  readonly messageId?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly subject?: string | undefined;
  readonly date?: Date | undefined;
  readonly from?: readonly ImapAddress[] | undefined;
}

/** A fetched message. `references`/`source` are present only when the query asked for them. */
export interface ImapFetchedMessage {
  readonly uid: number;
  readonly modseq?: bigint | undefined;
  readonly flags: ReadonlySet<string>;
  readonly internalDate?: Date | undefined;
  readonly size?: number | undefined;
  readonly envelope?: ImapEnvelope | undefined;
  /** Parsed `References` header ids (the adapter extracts these from the raw header line). */
  readonly references?: readonly string[] | undefined;
  /** Raw RFC822 message bytes — only when `query.source` was requested. */
  readonly source?: Buffer | undefined;
}

/** What to fetch. `changedSince` carries the CONDSTORE/QRESYNC modseq for cheap flag deltas. */
export interface ImapFetchQuery {
  readonly envelope?: boolean;
  readonly flags?: boolean;
  readonly internalDate?: boolean;
  readonly size?: boolean;
  readonly references?: boolean;
  readonly source?: boolean;
  readonly changedSince?: bigint;
}

/** Unsubscribe handle returned by the event subscriptions. */
export type Unsubscribe = () => void;

/**
 * The minimal IMAP surface the sync engine consumes. Deliberately small so a fake is trivial. The
 * connection is assumed to be ONE per watched mailbox (PROJECT.md §4); the engine never shares it.
 */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** Force-close the socket (used by the reconnect layer; never blocks). */
  close(): void;
  list(): Promise<readonly ImapFolderInfo[]>;
  openMailbox(path: string, options?: { readOnly?: boolean }): Promise<ImapMailboxState>;
  /** Fetch by UID. `range` is an IMAP UID range like `"1001:*"` or `"1,2,3"`. */
  fetchByUid(range: string, query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage>;
  onClose(listener: () => void): Unsubscribe;
  onError(listener: (error: Error) => void): Unsubscribe;
  onExists(listener: (event: ImapExistsEvent) => void): Unsubscribe;
}

export interface ImapExistsEvent {
  readonly path: string;
  readonly count: number;
  readonly prevCount: number;
}

/**
 * APPEND surface, kept SEPARATE from {@link ImapClient}. The send path files Sent/Drafts copies
 * through this; the read-only sync engine has no reason to append, so it cannot. This split keeps
 * the read path provably write-free for the Phase 3 checkpoint.
 */
export interface ImapAppendClient {
  append(
    path: string,
    raw: Buffer | string,
    flags?: readonly string[],
  ): Promise<{ uid?: number; uidValidity?: bigint } | null>;
}
