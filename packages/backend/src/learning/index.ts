/**
 * @mailordomo/backend · learning — silent, logged, revertable continuous learning (Phase 6,
 * PROJECT.md §6). Claude updates tone-memory markdown from (a) recurring draft instructions and
 * (b) the draft-vs-sent diff, writing a changelog the user can review and revert.
 *
 * GOLDEN RULE #1 (structural): this subtree has NO import path to the SMTP send module — learning runs
 * after a send and only ever edits tone markdown + writes a changelog; it can never transmit. The
 * boundary is enforced by the ESLint guard (`learning/** → smtp/**` forbidden) in addition to the fact
 * that nothing here imports a transmit path.
 *
 * Layout (PURE pieces split from the IO edge, per PLAN.md §2):
 *  - `signals`     — PURE: recurring-instruction detection + the draft-vs-sent diff.
 *  - `learn-schema`— the Sonnet `learn` job's `{tone_update, summary}` JSON Schema + zod validator.
 *  - `log`         — IO: the LOCAL changelog with before/after snapshots (revert; never crosses).
 *  - `learn`       — orchestrator: run the `learn` job → apply to tone → record (server summary + local).
 */
export * from './signals';
export * from './learn-schema';
export * from './log';
export * from './learn';
