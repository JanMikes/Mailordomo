/**
 * Pure engines (no IO) — the load-bearing, unit-testable core of the backend (PLAN.md §2).
 * The email-as-task state machine, the IMAP folder mapper, and the Phase 5 commitment engines:
 * the deterministic 3-way promise reconciler (+ relative-deadline resolver), the do-next ranker,
 * stale-thread detection, and the pure overdue-nudge trigger predicate.
 */
export * from './state-machine';
export * from './folder-mapper';
export * from './relative-deadline';
export * from './promise-reconciler';
export * from './ranker';
export * from './stale';
export * from './overdue-nudge';
