/**
 * @mailordomo/backend · repos — repo pointers in two modes (PLAN.md §7 Phase 8, D33; PROJECT.md §10).
 *
 *  - LOCAL PATH (preferred): the maintainer's live clone, validated + read via `claude --add-dir`
 *    (`local-path.ts`). The path is MACHINE-LOCAL (D13) and never reaches the server.
 *  - GIT URL + READ-ONLY MIRROR: a `git clone --mirror` kept fresh by a scheduled `git fetch`
 *    (`mirror.ts`), driven by the PURE due-set scheduler (`scheduler.ts`) and run through the
 *    injectable {@link GitRunner} seam (`git-runner.ts`) so CI never spawns real `git`.
 *
 * Phase 8 makes repos CONFIGURABLE + testable; it starts NO background fetch loop (D33 — the daemon
 * is Phase 9). Private-repo PAT/SSH auth is documented + deferred (#27, see `mirror.ts`).
 */
export * from './git-runner';
export * from './scheduler';
export * from './mirror';
export * from './local-path';
