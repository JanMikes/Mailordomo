/**
 * @mailordomo/backend — the local app backend (Node/TS).
 *
 * Public surface for the Phase 3 transport + cache + pure-engine layer and the Phase 4 Claude engine:
 *  - `engines/`   — the PURE state machine + IMAP folder mapper (load-bearing, unit-testable).
 *  - `threading/` — own JWZ threading over header sets.
 *  - `cache/`     — the disposable better-sqlite3 + FTS5 index and on-disk `.eml`/attachment store.
 *  - `imap/`      — the imapflow sync engine (injectable client seam, own reconnect, IDLE/poll).
 *  - `claude/`    — the Claude job runner (real/fake), concurrency queue + usage throttle, triage + summarize.
 *
 * The SMTP send path (`smtp/send`) and the background daemon (`daemon/`) are deliberately NOT
 * re-exported here: they are imported directly where used, preserving the structural no-send
 * boundary (PLAN.md §4.6). The daemon, metadata client and localhost API arrive in Phases 4.5–9.
 */
export const BACKEND_NAME = 'mailordomo-backend' as const;

export * from './engines';
export * from './threading';
export * from './cache';
export * from './imap';
export * from './claude';
