/**
 * Per-mailbox sync engine: turns the pure {@link computeSyncPlan} decision into cache writes using
 * an injected {@link ImapClient} (real imapflow OR a test fake) and the {@link MessageCache}.
 *
 * The READ path is the focus of the Phase 3 checkpoint, so by default the mailbox is opened
 * READ-ONLY and the engine only ever WRITES to the local cache — never to IMAP. Because the client
 * is injected, the test author drives this whole flow (incremental deltas, uidValidity invalidation,
 * resync) against a fake surface with no live server.
 */
import type { MessageCache } from '../cache/cache';
import { parseMessageIds } from '../threading/jwz';
import { computeSyncPlan } from './sync-plan';
import type { LocalFolderState, ServerFolderState, SyncPlan } from './sync-plan';
import type { ImapClient, ImapEnvelope, ImapFetchedMessage, ImapFetchQuery } from './types';

export interface MailboxSyncOptions {
  readonly mailboxAddress: string;
  readonly folderPath: string;
  /** Default true — the checkpoint runs strictly read-only. */
  readonly readOnly?: boolean;
  /** SPECIAL-USE flag for this folder (e.g. `"\\Sent"`), if the caller resolved it from LIST. */
  readonly specialUse?: string | null;
  /** Download raw `.eml` bytes during sync (requires the cache to have a blob dir). Default true. */
  readonly downloadSource?: boolean;
}

export interface SyncResult {
  readonly plan: SyncPlan;
  readonly fetched: number;
  readonly invalidated: boolean;
  readonly lastSeenUid: number;
}

const NEW_MESSAGE_QUERY: ImapFetchQuery = {
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
  references: true,
};

function formatSender(envelope: ImapEnvelope | undefined): string | null {
  const first = envelope?.from?.[0];
  if (!first) return null;
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? first.name ?? null;
}

function maxBigint(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

export class MailboxSync {
  private readonly client: ImapClient;
  private readonly cache: MessageCache;
  private readonly options: MailboxSyncOptions;

  constructor(client: ImapClient, cache: MessageCache, options: MailboxSyncOptions) {
    this.client = client;
    this.cache = cache;
    this.options = options;
  }

  /** Open the mailbox, compute the plan from the cache cursor, and apply it. Idempotent. */
  async syncOnce(): Promise<SyncResult> {
    const { mailboxAddress, folderPath } = this.options;
    const server = await this.client.openMailbox(folderPath, {
      readOnly: this.options.readOnly ?? true,
    });

    const existing = this.cache.getFolder(mailboxAddress, folderPath);
    const local: LocalFolderState = existing
      ? {
          uidValidity: existing.uid_validity,
          lastSeenUid: existing.last_seen_uid,
          highestModseq: existing.highest_modseq,
        }
      : { lastSeenUid: 0 };

    const serverState: ServerFolderState = {
      uidValidity: server.uidValidity.toString(),
      uidNext: server.uidNext,
      highestModseq: server.highestModseq?.toString() ?? null,
    };
    const plan = computeSyncPlan(local, serverState);

    // Invalidate BEFORE refreshing folder meta so the wipe uses the OLD uidValidity slice.
    let invalidated = false;
    if (plan.kind === 'full-resync' && existing) {
      this.cache.invalidateFolder(existing.id);
      invalidated = true;
    }

    const folder = this.cache.upsertFolderMeta({
      mailboxAddress,
      path: folderPath,
      specialUse: this.options.specialUse ?? null,
      uidValidity: serverState.uidValidity,
      uidNext: server.uidNext,
      highestModseq: serverState.highestModseq,
    });

    if (plan.kind === 'up-to-date') {
      return { plan, fetched: 0, invalidated, lastSeenUid: folder.last_seen_uid };
    }

    const fetched =
      plan.kind === 'full-resync'
        ? await this.fetchAndStore(folder.id, plan.fetchRange, NEW_MESSAGE_QUERY)
        : await this.applyIncremental(folder.id, plan);

    const refreshed = this.cache.getFolderById(folder.id);
    return {
      plan,
      fetched,
      invalidated,
      lastSeenUid: refreshed?.last_seen_uid ?? folder.last_seen_uid,
    };
  }

  private async applyIncremental(
    folderId: number,
    plan: Extract<SyncPlan, { kind: 'incremental' }>,
  ): Promise<number> {
    let fetched = 0;
    if (plan.fetchNewRange) {
      fetched += await this.fetchAndStore(folderId, plan.fetchNewRange, NEW_MESSAGE_QUERY);
    }
    if (plan.changedSince) {
      // Flag/state deltas only — cheap CONDSTORE re-read of already-known messages. Routed through
      // updateFlags (NOT the full upsert) so a flags-only fetch can't wipe the immutable envelope
      // (subject/message-id/sender/date) it doesn't carry. New messages were already stored in full
      // by the fetchNewRange pass above, so every changed UID is already cached.
      fetched += await this.applyFlagDeltas(folderId, BigInt(plan.changedSince));
    }
    return fetched;
  }

  /**
   * Apply a CONDSTORE flag/state delta: re-read flags for messages changed since `modseq` and update
   * ONLY their flags. Advances the modseq cursor, not the UID cursor (no new UIDs are introduced
   * here — those come via fetchNewRange).
   */
  private async applyFlagDeltas(folderId: number, changedSince: bigint): Promise<number> {
    let count = 0;
    let maxModseq: bigint | undefined;
    for await (const message of this.client.fetchByUid('1:*', { flags: true, changedSince })) {
      this.cache.updateFlags(folderId, message.uid, [...message.flags]);
      count += 1;
      maxModseq = maxBigint(maxModseq, message.modseq);
    }
    if (maxModseq !== undefined) {
      this.cache.setSyncCursor(folderId, 0, maxModseq.toString());
    }
    return count;
  }

  private async fetchAndStore(
    folderId: number,
    range: string,
    query: ImapFetchQuery,
  ): Promise<number> {
    const wantSource = (this.options.downloadSource ?? true) && this.cache.storage !== null;
    const effectiveQuery: ImapFetchQuery = wantSource ? { ...query, source: true } : query;

    let count = 0;
    let maxUid = 0;
    let maxModseq: bigint | undefined;
    const uidValidity = this.currentUidValidity(folderId);

    for await (const message of this.client.fetchByUid(range, effectiveQuery)) {
      this.storeMessage(folderId, uidValidity, message, wantSource);
      count += 1;
      if (message.uid > maxUid) maxUid = message.uid;
      maxModseq = maxBigint(maxModseq, message.modseq);
    }

    if (maxUid > 0 || maxModseq !== undefined) {
      this.cache.setSyncCursor(folderId, maxUid, maxModseq?.toString() ?? null);
    }
    return count;
  }

  private storeMessage(
    folderId: number,
    uidValidity: string,
    message: ImapFetchedMessage,
    wantSource: boolean,
  ): void {
    let emlPath: string | null = null;
    if (wantSource && message.source && this.cache.storage) {
      emlPath = this.cache.storage.storeEml(
        this.options.mailboxAddress,
        this.options.folderPath,
        uidValidity,
        message.uid,
        message.source,
      );
    }

    const references = message.references ?? parseMessageIds(message.envelope?.inReplyTo ?? null);

    this.cache.upsertMessage({
      folderId,
      uid: message.uid,
      uidValidity,
      messageId: message.envelope?.messageId ?? null,
      inReplyTo: message.envelope?.inReplyTo ?? null,
      references: references.length > 0 ? references : null,
      subject: message.envelope?.subject ?? null,
      sender: formatSender(message.envelope),
      internalDate: message.internalDate ?? null,
      size: message.size ?? null,
      flags: [...message.flags],
      emlPath,
    });
  }

  private currentUidValidity(folderId: number): string {
    const folder = this.cache.getFolderById(folderId);
    return folder?.uid_validity ?? '0';
  }
}
