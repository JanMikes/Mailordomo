/**
 * Tone-file sync ORCHESTRATOR (Golden rule #2 / PROJECT.md §3: synced cross-machine via the metadata
 * server as the LWW arbiter, **per file**, never a two-way merge). It wires the {@link ToneStore}
 * (local truth) to the metadata service (the arbiter) and reconciles WHOLE FILES only:
 *
 *  1. PUSH every local tone file (`putToneFile`). The SERVER arbitrates LWW and returns the
 *     post-resolution authoritative `file`; we ADOPT it locally regardless of the verdict — so when
 *     the server already had a NEWER version, its file wholly overwrites ours (an LWW pull disguised
 *     as a push response). `accepted=true` ⇒ our version won; `accepted=false` ⇒ we adopted theirs.
 *  2. PULL any server file we don't yet have locally (or that is newer than ours) — `listToneFiles`
 *     then `decideLww(localMeta, serverMeta)`; on `pull`, adopt the server file. Step 1 already pushed
 *     everything we had, so this step mostly fetches files that only exist on the server (e.g. created
 *     on the other machine).
 *
 * Whole-file replacement only — `decideLww` (pure) decides DIRECTION, `store.adopt`/the server decide
 * the WINNER; nowhere do we merge fields between the two stores. INJECTED client (narrow interface) +
 * store, so the orchestrator is testable against the real in-process server or a fake.
 */
import type { PutToneFileRequest, ToneFile } from '@mailordomo/shared';
import { decideLww } from './lww';
import type { ToneStore } from './store';

/** The narrow slice of the metadata client this orchestrator needs (the real client satisfies it). */
export interface ToneSyncClient {
  putToneFile(req: PutToneFileRequest): Promise<{ accepted: boolean; file: ToneFile }>;
  listToneFiles(): Promise<ToneFile[]>;
}

/** What each file's reconciliation did, for logging/UX (the changelog of a sync run). */
export interface ToneSyncReport {
  /** Paths whose LOCAL version the server accepted (we won). */
  readonly pushed: string[];
  /** Paths we adopted from the server (it was newer, or only existed there). */
  readonly pulled: string[];
  /** Paths already identical on both sides (no write). */
  readonly noop: string[];
}

/** Build the strict `PUT /tone` request from a stored tone file (identity-shaped; kept explicit). */
function toPutToneFileRequest(file: ToneFile): PutToneFileRequest {
  return {
    project_id: file.project_id,
    scope: file.scope,
    path: file.path,
    content: file.content,
    version_hash: file.version_hash,
    updated_by: file.updated_by,
    updated_at: file.updated_at,
  };
}

/**
 * Reconcile the local tone store with the metadata server (LWW per file). Returns a report of what
 * each file did. Idempotent at a fixed point: a second run with no edits on either side is all-noop.
 */
export async function syncToneFiles(
  client: ToneSyncClient,
  store: ToneStore,
): Promise<ToneSyncReport> {
  const pushed = new Set<string>();
  const pulled = new Set<string>();
  const noop = new Set<string>();

  // 1. Push every local file; adopt the authoritative response (LWW per file — never a merge).
  for (const local of store.list()) {
    const res = await client.putToneFile(toPutToneFileRequest(local));
    // Adopt the post-resolution truth so local == authoritative exactly (verbatim server metadata).
    store.adopt(res.file);
    if (res.accepted) {
      pushed.add(res.file.path);
    } else {
      // The server already had a newer version; adopting it is an LWW pull.
      pulled.add(res.file.path);
    }
  }

  // 2. Pull any server file that is newer than (or absent from) the local store.
  const serverFiles = await client.listToneFiles();
  for (const serverFile of serverFiles) {
    if (pushed.has(serverFile.path) || pulled.has(serverFile.path)) {
      // Already reconciled in step 1.
      continue;
    }
    const localMeta = store.meta(serverFile.path);
    const decision = decideLww(localMeta, {
      version_hash: serverFile.version_hash,
      updated_at: serverFile.updated_at,
    });
    if (decision === 'pull') {
      store.adopt(serverFile);
      pulled.add(serverFile.path);
    } else {
      // `noop` (identical) — `push` is impossible here (step 1 already pushed everything local).
      noop.add(serverFile.path);
    }
  }

  return { pushed: [...pushed], pulled: [...pulled], noop: [...noop] };
}
