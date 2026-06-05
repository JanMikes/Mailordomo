/**
 * Local tone-file persistence (PROJECT.md §3/§5: tone-memory markdown files are "Claude's native
 * memory" — local Markdown Claude reads directly, synced cross-machine via the server as LWW arbiter).
 *
 * NOT THE DISPOSABLE CACHE: the SQLite + `.eml` cache is rebuildable from IMAP and may be wiped at
 * will; tone files are NOT — they hold derived voice memory the user curates. So they live under their
 * OWN directory (`TONE_DIR`, default `.mailordomo-tone/`), kept SEPARATE from `CACHE_DB_PATH`/
 * `CACHE_BLOB_DIR`. A ToneFile's `path` (e.g. `contact/jan@acme.com.md`) maps to `<dir>/<path>`; the
 * markdown content is the file, and the per-file LWW metadata (`version_hash`/`updated_at`/
 * `updated_by`/`project_id`) lives in a small JSON sidecar index `<dir>/.tone-index.json` — also
 * outside the disposable cache.
 *
 * `version_hash` is a DETERMINISTIC CONTENT HASH (hex sha256 of `content`, matching `HashSchema`): the
 * same content on two machines yields the IDENTICAL hash, which is exactly what makes the server's
 * LWW no-op detection + hash tie-break correct (identical re-push is a no-op; an `updated_at` tie is
 * broken by a stable content hash, not a random token).
 *
 * Two distinct writes:
 *  - `write(...)` — a LOCAL edit: stamps a FRESH `version_hash` from the new content + the caller's
 *    `updated_at`.
 *  - `adopt(serverFile)` — an LWW PULL: replaces the local file WHOLESALE with the server's
 *    authoritative version, storing the server's `version_hash`/`updated_at` VERBATIM (the server is
 *    the arbiter and trusts the client hash; recomputing would yield the same hash anyway since it is
 *    content-only, but adopting verbatim keeps local == authoritative exactly). Never a field merge.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectId, ToneFile, ToneScope } from '@mailordomo/shared';

/** Default tone-files directory when `TONE_DIR` is unset. Kept separate from the disposable cache. */
export const DEFAULT_TONE_DIR = '.mailordomo-tone';

/** The sidecar index filename inside the tone dir (LWW metadata; outside the disposable cache). */
export const TONE_INDEX_FILE = '.tone-index.json';

/**
 * Resolve the tone-files directory from the environment (mirrors the cache's `CACHE_DB_PATH ?? …`
 * convention in `api/server.ts`). `TONE_DIR` wins; otherwise the default. The caller may nest it
 * per-project if a machine carries multiple projects.
 */
export function resolveToneDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['TONE_DIR'];
  return dir !== undefined && dir.trim() !== '' ? dir : DEFAULT_TONE_DIR;
}

/**
 * DETERMINISTIC content hash for `version_hash` — hex sha256 of the content. Pure (crypto is a pure
 * computation): identical content ⇒ identical hash on every machine, which the LWW tie-break relies on.
 */
export function toneVersionHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The LWW-relevant metadata a local edit supplies (the content is hashed; the rest is stamped). */
export interface ToneWriteInput {
  readonly scope: ToneScope;
  /** Stable path/key within the project, e.g. `contact/jan@acme.com.md`. Maps to `<dir>/<path>`. */
  readonly path: string;
  readonly content: string;
  /** Actor attributed with this write (for the changelog/LWW `updated_by`). */
  readonly updated_by: string;
  /** ISO-8601 instant of this write — INJECTED by the caller (no `Date.now()` in the store path). */
  readonly updated_at: string;
}

/** One entry in the JSON sidecar index — everything but the content (which is the file on disk). */
interface ToneIndexEntry {
  readonly project_id: ProjectId;
  readonly scope: ToneScope;
  readonly version_hash: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

interface ToneIndex {
  readonly version: 1;
  readonly files: Record<string, ToneIndexEntry>;
}

export interface ToneStoreOptions {
  /** The tone-files directory (resolve with {@link resolveToneDir}). */
  readonly dir: string;
  /** The project these tone files belong to (stamped onto every stored file). */
  readonly projectId: ProjectId;
}

/**
 * Reject a tone `path` that would escape the tone dir (path traversal / absolute). The path is a
 * multi-segment RELATIVE key by design (`contact/<addr>.md`), so we validate it stays under `dir`.
 */
function resolveWithinDir(dir: string, relPath: string): string {
  const resolved = path.resolve(dir, relPath);
  const base = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`tone file path escapes the tone dir: ${relPath}`);
  }
  if (resolved === base) {
    throw new Error(`tone file path must name a file, not the tone dir itself: ${relPath}`);
  }
  return resolved;
}

/**
 * The local tone-file store. Single-project (constructed with a `projectId`); a machine carrying
 * multiple projects nests one `dir` per project. IO lives here; the resolver (`resolve.ts`) and LWW
 * reconciler (`lww.ts`) are PURE and consume the shapes this store reads/writes.
 */
export class ToneStore {
  readonly dir: string;
  readonly projectId: ProjectId;

  private constructor(options: ToneStoreOptions) {
    this.dir = options.dir;
    this.projectId = options.projectId;
  }

  /** Open (and create) a tone store rooted at `dir` for `projectId`. */
  static open(options: ToneStoreOptions): ToneStore {
    const store = new ToneStore(options);
    store.init();
    return store;
  }

  /** Ensure the tone dir exists. Idempotent. */
  init(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private indexPath(): string {
    return path.join(this.dir, TONE_INDEX_FILE);
  }

  private readIndex(): ToneIndex {
    const file = this.indexPath();
    if (!existsSync(file)) {
      return { version: 1, files: {} };
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ToneIndex;
    // Tolerate a hand-edited/empty index: default the files map.
    return { version: 1, files: raw.files ?? {} };
  }

  private writeIndex(index: ToneIndex): void {
    writeFileSync(this.indexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  /** Reconstruct the full shared {@link ToneFile} from an index entry + the content on disk. */
  private toToneFile(relPath: string, entry: ToneIndexEntry): ToneFile {
    const content = readFileSync(resolveWithinDir(this.dir, relPath), 'utf8');
    return {
      project_id: entry.project_id,
      scope: entry.scope,
      path: relPath,
      content,
      version_hash: entry.version_hash,
      updated_by: entry.updated_by,
      updated_at: entry.updated_at,
    };
  }

  /** Every tone file known locally (full shared shape), for the push side of sync. */
  list(): ToneFile[] {
    const index = this.readIndex();
    const files: ToneFile[] = [];
    for (const [relPath, entry] of Object.entries(index.files)) {
      // Skip an index entry whose content file vanished (defensive; the cache may be wiped, tone not).
      if (existsSync(resolveWithinDir(this.dir, relPath))) {
        files.push(this.toToneFile(relPath, entry));
      }
    }
    return files;
  }

  /** Read one tone file by its `path`, or `undefined` if absent. */
  read(relPath: string): ToneFile | undefined {
    const entry = this.readIndex().files[relPath];
    if (entry === undefined) return undefined;
    if (!existsSync(resolveWithinDir(this.dir, relPath))) return undefined;
    return this.toToneFile(relPath, entry);
  }

  /** The LWW metadata for one file (for `decideLww`), or `undefined` if absent. */
  meta(relPath: string): { version_hash: string; updated_at: string } | undefined {
    const entry = this.readIndex().files[relPath];
    if (entry === undefined) return undefined;
    return { version_hash: entry.version_hash, updated_at: entry.updated_at };
  }

  /**
   * Persist a LOCAL edit: write the content to `<dir>/<path>`, stamp a fresh content `version_hash`
   * and the caller's `updated_at`/`updated_by` into the index, and return the stored {@link ToneFile}.
   */
  write(input: ToneWriteInput): ToneFile {
    const target = resolveWithinDir(this.dir, input.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, input.content, 'utf8');

    const entry: ToneIndexEntry = {
      project_id: this.projectId,
      scope: input.scope,
      version_hash: toneVersionHash(input.content),
      updated_by: input.updated_by,
      updated_at: input.updated_at,
    };
    const index = this.readIndex();
    this.writeIndex({ version: 1, files: { ...index.files, [input.path]: entry } });

    return {
      project_id: entry.project_id,
      scope: entry.scope,
      path: input.path,
      content: input.content,
      version_hash: entry.version_hash,
      updated_by: entry.updated_by,
      updated_at: entry.updated_at,
    };
  }

  /**
   * LWW PULL: adopt a server-authoritative {@link ToneFile} WHOLESALE — overwrite the local content
   * AND store the server's `version_hash`/`updated_at`/`updated_by` VERBATIM (the server is the
   * arbiter). This is the only correct response to "the server returned the post-resolution file":
   * whole-file replacement, never a merge.
   */
  adopt(file: ToneFile): void {
    const target = resolveWithinDir(this.dir, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, 'utf8');

    const entry: ToneIndexEntry = {
      // Trust the server's stamped fields verbatim; scope/project come from the authoritative file.
      project_id: file.project_id,
      scope: file.scope,
      version_hash: file.version_hash,
      updated_by: file.updated_by,
      updated_at: file.updated_at,
    };
    const index = this.readIndex();
    this.writeIndex({ version: 1, files: { ...index.files, [file.path]: entry } });
  }

  /** Remove the entire tone dir (test hygiene / a full local reset). NOT part of normal operation. */
  destroy(): void {
    if (existsSync(this.dir)) {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  /** Diagnostic: the relative paths currently indexed (not part of the sync contract). */
  paths(): string[] {
    return Object.keys(this.readIndex().files);
  }
}
