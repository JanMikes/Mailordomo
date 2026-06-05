/**
 * @mailordomo/server — the shared metadata service (Hono + better-sqlite3, WAL).
 *
 * Source of truth for task state & transitions (with actor attribution), deadlines/follow-ups,
 * 3-way promises, notes, repo pointers, draft *metadata*, locks, and subject/snippet/sender for
 * shared digests. It NEVER stores raw email bodies or draft bodies. Built in Phase 2 with a
 * repository layer (so a SQLite -> Postgres swap stays mechanical), bearer-token pairing, a
 * Dockerfile, and a GHCR build-and-publish workflow. Phase 0 carries only the package marker.
 */
export const SERVER_NAME = 'mailordomo-metadata-service' as const;
