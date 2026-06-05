/**
 * @mailordomo/backend — the local app backend (Node/TS).
 *
 * Public surface for the Phase 3 transport + cache + pure-engine layer and the Phase 4 Claude engine:
 *  - `engines/`   — the PURE state machine + IMAP folder mapper (load-bearing, unit-testable).
 *  - `threading/` — own JWZ threading over header sets.
 *  - `cache/`     — the disposable better-sqlite3 + FTS5 index and on-disk `.eml`/attachment store.
 *  - `imap/`      — the imapflow sync engine (injectable client seam, own reconnect, IDLE/poll).
 *  - `claude/`    — the Claude job runner (real/fake), concurrency queue + usage throttle, triage + summarize.
 *  - `tone/`      — layered tone memory (PURE resolver + PURE LWW reconciler) + the local store +
 *                   cross-machine LWW sync (Phase 6). Tone files live OUTSIDE the disposable cache.
 *  - `learning/`  — silent, logged, revertable continuous learning (Phase 6): PURE signals + the
 *                   Sonnet `learn` job + the local changelog. No import path to the send module.
 *  - `metadata-client/` — the typed HTTP client for the metadata service (Phase 4.5; metadata only,
 *                   injectable `fetch` seam, zod-validated responses).
 *  - `settings/`  — the LOCAL app settings store (Phase 7a): a JSON config file (stale thresholds,
 *                   lock timeout, color scheme) read by the backend and exposed via `/api/settings`.
 *  - `api/`       — the thin localhost backend API factory (`createBackendApi`) + wiring checks +
 *                   the Today read-model assembler + the WS server (Phase 4.5 / 7a). The runnable
 *                   `api/server.ts` entry is NOT re-exported (it has a listen side-effect); import it
 *                   only to start the server.
 *
 * The SMTP send path (`smtp/send`) and the background daemon (`daemon/`) are deliberately NOT
 * re-exported here: they are imported directly where used, preserving the structural no-send
 * boundary (PLAN.md §4.6). The daemon arrives in Phase 5+.
 */
export const BACKEND_NAME = 'mailordomo-backend' as const;

export * from './engines';
export * from './threading';
export * from './cache';
export * from './imap';
export * from './claude';
export * from './tone';
export * from './learning';
export * from './metadata-client';
export * from './settings';
export * from './api';
