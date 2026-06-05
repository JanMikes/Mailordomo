/**
 * Background daemon — poll -> triage -> state -> promises -> stale -> summarize.
 *
 * STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6): this module, and everything under
 * `daemon/**`, must have NO import path to `../smtp/send`. The daemon may DRAFT (including the one
 * sanctioned overdue-nudge case) but it can never reach the code that transmits over SMTP.
 * The boundary is enforced by the `no-restricted-imports` rule in `eslint.config.js`, which fails
 * `lint` — and therefore the commit/push gate — before tests even run. See `sendguard.test.ts`.
 *
 * Phase 0 is just the marker; the real daemon lands in Phases 4-9.
 *
 * NUDGE WIRING NOTE (Golden rule #1): when the daemon triggers the sanctioned overdue-nudge it runs
 * the PURE lapsed-promise predicate + the Opus draft job, but the `DraftFiler` (which wraps
 * `saveDraft`) MUST be injected from the API/orchestrator layer — never imported here. `saveDraft`
 * lives under `smtp/**`, which the lint guard forbids the daemon from importing, so binding the
 * filer inside `daemon/**` would fail `lint`. Keep the filer binding outside the daemon.
 */
export const DAEMON_NAME = 'mailordomo-daemon' as const;
