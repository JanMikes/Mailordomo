/**
 * @mailordomo/shared — the single source of truth for cross-boundary contracts.
 *
 * Every shape that crosses a boundary (local app ↔ metadata service, client ↔ server types) is a
 * zod schema here, with its inferred TypeScript type. Modules:
 *  - `primitives` — id / datetime / email / snippet / sender / hash building blocks.
 *  - `enums`      — closed vocabularies (task state, promise direction/status, tone scope, model
 *                   alias, task kind, importance, transition mode, actor).
 *  - `entities`   — the metadata-service entities from PROJECT.md §5 (the stored shapes).
 *  - `digest`     — morning-digest read models (subject/snippet/sender + attributed transitions).
 *  - `today`      — the LOCAL Today command-center read model (metrics + counts + do-next cards).
 *  - `settings`   — the LOCAL app settings (stale thresholds, lock timeout, color scheme).
 *  - `api`        — request/response contracts for the metadata service (ALL strict; the privacy
 *                   boundary lives here and in `privacy`).
 *  - `routing`    — fixed model routing + the checkable Golden-rule-#6 invariant.
 *  - `states`     — the task-state transition table AS DATA + tiny lookups.
 *  - `privacy`    — the documented body-never-leaves boundary + forbidden-key test target.
 */
export const MAILORDOMO = 'mailordomo' as const;

export * from './primitives';
export * from './enums';
export * from './privacy';
export * from './routing';
export * from './states';
export * from './entities';
export * from './digest';
export * from './today';
export * from './settings';
export * from './api';
