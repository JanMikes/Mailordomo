/**
 * On-disk side of the disposable cache: raw `.eml` messages + attachments as FILES (PROJECT.md §3,
 * decision D18). Attachments are CONTENT-ADDRESSED for dedup; the DB stores PATHS, never BLOBs.
 *
 * Everything here is local-only and rebuildable: the whole tree can be wiped and repopulated from
 * IMAP. It is a MIRROR — data only ever flows IMAP → disk, never the reverse.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** SHA-256 hex of a buffer — the content address used for attachment dedup. */
export function contentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Make an arbitrary string safe to use as a single path segment (no separators / control chars). */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._@+-]/g, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * The local cache directory layout. `root` holds everything; messages live under
 * `messages/<mailbox>/<folder>/<uidValidity>/<uid>.eml` (the cache key made visible on disk), and
 * content-addressed attachments under `blobs/<aa>/<sha256>`.
 */
export class CacheStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Ensure the base directories exist. Idempotent. */
  init(): void {
    mkdirSync(this.messagesRoot(), { recursive: true });
    mkdirSync(this.blobsRoot(), { recursive: true });
  }

  private messagesRoot(): string {
    return path.join(this.root, 'messages');
  }

  private blobsRoot(): string {
    return path.join(this.root, 'blobs');
  }

  /** Absolute path of a folder's message directory, keyed by (mailbox, folder, uidValidity). */
  folderDir(mailboxAddress: string, folderPath: string, uidValidity: string): string {
    return path.join(
      this.messagesRoot(),
      safeSegment(mailboxAddress),
      safeSegment(folderPath),
      safeSegment(uidValidity),
    );
  }

  /** Absolute path of a single message's raw `.eml`, keyed by (mailbox, uidValidity, uid). */
  emlPath(mailboxAddress: string, folderPath: string, uidValidity: string, uid: number): string {
    return path.join(this.folderDir(mailboxAddress, folderPath, uidValidity), `${uid}.eml`);
  }

  /** Write a raw message to disk and return its absolute path. */
  storeEml(
    mailboxAddress: string,
    folderPath: string,
    uidValidity: string,
    uid: number,
    raw: Buffer,
  ): string {
    const dir = this.folderDir(mailboxAddress, folderPath, uidValidity);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${uid}.eml`);
    writeFileSync(file, raw);
    return file;
  }

  /** Content-addressed attachment path for a given hash (`blobs/<first2>/<hash>`). */
  blobPath(hash: string): string {
    return path.join(this.blobsRoot(), hash.slice(0, 2), hash);
  }

  /**
   * Store an attachment by content. If an identical blob already exists it is NOT rewritten
   * (dedup); the returned `deduped` flag says which happened. Returns the hash + absolute path the
   * caller records in the DB.
   */
  storeBlob(buffer: Buffer): { hash: string; path: string; deduped: boolean } {
    const hash = contentHash(buffer);
    const file = this.blobPath(hash);
    if (existsSync(file)) {
      return { hash, path: file, deduped: true };
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buffer);
    return { hash, path: file, deduped: false };
  }

  /** Wipe one folder's stored `.eml` files (used on a uidValidity-driven invalidation). */
  wipeFolder(mailboxAddress: string, folderPath: string, uidValidity: string): void {
    rmSync(this.folderDir(mailboxAddress, folderPath, uidValidity), {
      recursive: true,
      force: true,
    });
  }

  /** Wipe ALL on-disk cache (the disk half of rebuild-from-empty). Blobs included. */
  wipeAll(): void {
    rmSync(this.messagesRoot(), { recursive: true, force: true });
    rmSync(this.blobsRoot(), { recursive: true, force: true });
  }
}
