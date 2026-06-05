/**
 * @mailordomo/backend — the local app backend (Node/TS).
 *
 * Houses the IMAP/SMTP sync engine, the disposable SQLite+FTS5 cache and `.eml` store, JWZ
 * threading, the Claude job runner, the background daemon, the pure engines (state machine,
 * 3-way reconciler, do-next ranker, IMAP folder mapper), the metadata client, and the localhost
 * API. Built across Phases 3-9. Phase 0 carries only the package marker plus the daemon/send
 * module skeletons that establish the structural no-send boundary (PLAN.md §4.6).
 */
export const BACKEND_NAME = 'mailordomo-backend' as const;
