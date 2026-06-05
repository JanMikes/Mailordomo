/**
 * @mailordomo/backend · settings — the LOCAL app settings store (PLAN.md §7 Phase 7a, D27/D29).
 * A small JSON-file config (stale thresholds, lock timeout, color scheme), read/written by the
 * backend and exposed to the frontend via `GET`/`PUT /api/settings`. Not server state, not
 * localStorage-as-truth.
 */
export * from './store';
