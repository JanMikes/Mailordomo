/**
 * @mailordomo/backend · drafts — LOCAL-ONLY draft persistence (PLAN.md §7 Phase 7b, D31).
 *
 * The draft BODY + refine TRANSCRIPT are machine-local (golden rules #2 + #3): they live in a
 * dedicated better-sqlite3 DB at `$MAILORDOMO_CONFIG_DIR/drafts.db`, SEPARATE from the disposable
 * message cache and NEVER synced to the metadata server. Only `DraftMeta` (no body) crosses the
 * boundary. This module exposes the {@link DraftStore} interface + its file-backed and in-memory
 * impls. It has NO import path to `smtp/**` — it only persists text.
 */
export * from './types';
export * from './store';
export * from './fake';
