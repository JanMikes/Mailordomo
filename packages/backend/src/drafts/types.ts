/**
 * LOCAL-ONLY draft types for the split work surface (PLAN.md §7 Phase 7b, decision D31).
 *
 * GOLDEN RULE #3 (bodies never leave) — these are deliberately BACKEND-LOCAL types, NOT shared
 * server-bound DTOs: a draft BODY and its refine TRANSCRIPT live ONLY on this machine, in the
 * {@link DraftStore}. The only thing that ever crosses to the metadata server is `DraftMeta`
 * (version/model/author/at — no body), via `MetadataClient.createDraftMeta`. There is therefore NO
 * zod schema for these in `@mailordomo/shared`, by design — a draft body must be unable to typecheck
 * into any server payload.
 *
 * GOLDEN RULE #5 (replay, not resume) — the refine chat is reconstructed by REPLAYING this
 * {@link RefineTurn}[] transcript into a fresh stateless `claude -p` call each turn. The backend owns
 * the transcript here; the frontend posts only the new instruction.
 */

/** One turn in the refine conversation. `user` = an instruction; `assistant` = a produced draft body. */
export interface RefineTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** The persisted local draft for one thread (latest body + the full refine transcript). */
export interface LocalDraft {
  readonly threadId: string;
  /** The latest draft body (LOCAL ONLY — never sent to the metadata server). */
  readonly body: string;
  /** Bumped on every save (first draft = 1; each refine increments). Mirrors `DraftMeta.version`. */
  readonly version: number;
  /** The model alias that produced this draft (`opus` for drafts) — for the UI model badge + DraftMeta. */
  readonly model: string;
  /** Actor attributed with the draft (e.g. {@link AUTOMATED_ACTOR} — Claude produced it). */
  readonly author: string;
  /** ISO-8601 instant the latest version was saved. */
  readonly createdAt: string;
  /** The full refine conversation (replayed per golden rule #5). LOCAL ONLY. */
  readonly transcript: RefineTurn[];
}

/** Input to {@link DraftStore.saveDraft} — the store assigns/bumps `version` + `createdAt`. */
export interface SaveDraftInput {
  readonly body: string;
  readonly model: string;
  readonly author: string;
  readonly transcript: readonly RefineTurn[];
  /** ISO-8601 "now" for `createdAt` — INJECTED for determinism; defaults to the wall clock. */
  readonly createdAt?: string;
}

/**
 * LOCAL draft persistence, keyed by `thread_id`. Mirrors the {@link SettingsStore} shape (tiny,
 * synchronous, injectable). The file-backed impl lives at `$MAILORDOMO_CONFIG_DIR/drafts.db` — kept
 * SEPARATE from the disposable message cache (draft bodies are NOT rebuildable from IMAP/metadata, so
 * they must survive a cache wipe) and NEVER synced to the server (golden rules #2 + #3). An in-memory
 * fake ({@link createMemoryDraftStore}) is provided for tests.
 */
export interface DraftStore {
  /** The current local draft for a thread, or `undefined` when none exists. */
  getDraft(threadId: string): LocalDraft | undefined;
  /** Persist the latest draft for a thread, bumping `version`. Returns the stored {@link LocalDraft}. */
  saveDraft(threadId: string, input: SaveDraftInput): LocalDraft;
  /** Remove a thread's draft entirely (e.g. after a successful manual send). Idempotent. */
  clearDraft(threadId: string): void;
}
