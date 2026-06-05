/**
 * @mailordomo/backend · api — the thin localhost backend API (PLAN.md §7 Phase 4.5).
 *
 * `createBackendApi(deps)` is the testable Hono factory (inject the MetadataClient + cache, mirror of
 * the server's `createApp`). `server.ts` is the runnable entry that wires real deps and binds to
 * 127.0.0.1. The wiring checks + the cached-thread view are exported for tests/consumers.
 */
export * from './app';
export * from './wiring';
export * from './threads-view';
export * from './today-view';
export * from './thread-detail-view';
export * from './draft-tone';
export * from './ws';
