/**
 * Pure lock-timeout helpers (PROJECT.md §6 "timeout release"; PLAN.md open Q #24 → 30 min).
 *
 * The Jan/Simona double-handling guard hinges on a TTL: a lock is held until `expires_at`, a
 * heartbeat (`refresh`) pushes `expires_at` forward, and an EXPIRED lock is free for anyone to
 * take. These helpers keep the timeout arithmetic in one tested place; the read-modify-write
 * orchestration (atomic, in a transaction) lives in the sqlite repository.
 */

/** Default time-to-live before a lock auto-expires, in seconds (30 minutes). */
export const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;

/** A lock is expired once `now` reaches or passes `expires_at`. */
export function isExpired(expiresAtIso: string, now: Date): boolean {
  return Date.parse(expiresAtIso) <= now.getTime();
}

/** Compute a new `expires_at` (ISO-8601 UTC) `ttlSeconds` after `now`. */
export function computeExpiry(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

/** Resolve a requested TTL, applying the server default when the client omitted one. */
export function resolveTtlSeconds(
  ttlSeconds: number | undefined,
  fallback: number = DEFAULT_LOCK_TTL_SECONDS,
): number {
  return ttlSeconds ?? fallback;
}
