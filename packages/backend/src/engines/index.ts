/**
 * Pure engines (no IO) — the load-bearing, unit-testable core of the backend (PLAN.md §2).
 * Currently: the email-as-task state machine and the IMAP folder mapper. The 3-way promise
 * reconciler and the do-next ranker join here in Phase 5.
 */
export * from './state-machine';
export * from './folder-mapper';
