/**
 * Background daemon (PROJECT.md §6; PLAN.md D34) — poll → triage + state inference → 3-way promise
 * tracking → stale detection → thread summarization → the sanctioned overdue-nudge (draft, never
 * send). The orchestrator (`runDaemonCycle`) composes the existing engines over an injected message
 * source; `startDaemon` runs it on an IDLE-hot + poll-cold cadence.
 *
 * STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6): this module, and everything under
 * `daemon/**`, has NO import path to `smtp/**`, `api/**`, or the backend root barrel — the D18/D31
 * `no-restricted-imports`/`no-restricted-syntax` ESLint rules fail `lint` (and the commit/push gate)
 * on any such import, before tests run. The daemon may DRAFT (including the one sanctioned overdue
 * nudge), but the {@link DraftFiler} that performs the save is a narrow, transmit-free seam
 * constructed OUTSIDE the daemon (in the composition root, which may import smtp) and INJECTED here.
 * Result: it is structurally impossible for the daemon to send. The Phase 9 smoke + E2E tests assert
 * the behavior (0 real sends; a hostile transmit-spy filer is never reached with a transmit verb).
 */
export const DAEMON_NAME = 'mailordomo-daemon' as const;

export * from './types';
export * from './cycle';
export * from './loop';
