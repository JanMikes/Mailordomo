/**
 * Stale-thread DETECTION — a PURE engine (no IO, no wall clock; "now" is injected).
 *
 * PROJECT.md §6/§9: the background daemon runs "stale-thread detection" and the do-next queue uses
 * staleness (§8 step 3). A thread is STALE when it has been sitting without progress long enough that
 * it needs the user's attention — and WHY it is stale depends on its state:
 *
 *  - `waiting`   — I sent and am awaiting their reply. Stale once a follow-up deadline has passed
 *                  (if one is set) OR no activity for {@link DEFAULT_WAITING_STALE_DAYS} days. This is
 *                  the signal that should flip `waiting → follow-up` (the state machine's `auto` edge).
 *  - `follow-up` — already flagged to chase. Stale (i.e. due to act on) immediately once it is in this
 *                  state — that IS the "go chase it" state — or, with a deadline, once that deadline
 *                  passes. Surfaces for the (manual) follow-up / the sanctioned nudge.
 *  - `needs-reply` / `drafted` — I owe the next move. Stale once it has gone unanswered for
 *                  {@link DEFAULT_NEEDS_REPLY_STALE_DAYS} days (I'm sitting on a ball in my court).
 *  - `done`      — never stale (no work owed).
 *
 * Thresholds are sensible DEFAULTS (documented above), overridable via {@link StaleThresholds}. The
 * function is total and pure: same inputs → same verdict, unit-testable with a fixed `now`.
 */
import type { StaleReason, TaskState } from '@mailordomo/shared';

// Re-export so existing consumers (and tests) can keep importing `StaleReason` from the engine; the
// vocabulary itself now lives in `@mailordomo/shared` (one source of truth, shared with the Today
// contract). See `shared/src/enums.ts` for the value list + per-reason UI meaning.
export type { StaleReason };

/** A `waiting` thread with no follow-up deadline is stale after this many days of silence. */
export const DEFAULT_WAITING_STALE_DAYS = 3;

/** A `needs-reply`/`drafted` thread I'm sitting on is stale after this many days. */
export const DEFAULT_NEEDS_REPLY_STALE_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Overridable thresholds (days). Omitted fields fall back to the documented defaults. */
export interface StaleThresholds {
  readonly waitingStaleDays?: number;
  readonly needsReplyStaleDays?: number;
}

/** The stale verdict for one thread. */
export interface StaleVerdict {
  readonly stale: boolean;
  /** Present iff `stale`. */
  readonly reason?: StaleReason;
  /** Age in ms since last activity at evaluation time (null when last activity is unknown). */
  readonly ageMs: number | null;
}

/** The per-thread inputs the detector reasons over (a projection of Task + Thread). */
export interface StaleInput {
  readonly state: TaskState;
  /** ISO-8601 of the thread's last activity (last message / last transition). Null = unknown. */
  readonly lastActivityIso: string | null;
  /** ISO-8601 follow-up deadline for a `waiting`/`follow-up` task, if one is set. */
  readonly followUpAtIso?: string | null;
  /** ISO-8601 hard deadline on the task, if one is set (also makes a thread due once passed). */
  readonly deadlineIso?: string | null;
}

function ageSince(lastActivityIso: string | null, nowMs: number): number | null {
  if (lastActivityIso === null) return null;
  const last = Date.parse(lastActivityIso);
  if (Number.isNaN(last)) return null;
  return nowMs - last;
}

/** True iff `iso` parses and is strictly before `nowMs`. */
function hasPassed(iso: string | null | undefined, nowMs: number): boolean {
  if (iso === null || iso === undefined) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t < nowMs;
}

/**
 * Decide whether a thread is stale at `nowIso`, and why. Pure. The order of checks encodes priority:
 * an elapsed deadline/follow-up time is the strongest signal, then state-specific silence thresholds.
 */
export function detectStale(
  input: StaleInput,
  nowIso: string,
  thresholds: StaleThresholds = {},
): StaleVerdict {
  const nowMs = Date.parse(nowIso);
  const ageMs = ageSince(input.lastActivityIso, nowMs);

  // `done` is never stale.
  if (input.state === 'done') {
    return { stale: false, ageMs };
  }

  const waitingDays = thresholds.waitingStaleDays ?? DEFAULT_WAITING_STALE_DAYS;
  const needsReplyDays = thresholds.needsReplyStaleDays ?? DEFAULT_NEEDS_REPLY_STALE_DAYS;

  // A passed follow-up time or hard deadline is the strongest, state-agnostic staleness signal.
  if (hasPassed(input.followUpAtIso, nowMs) || hasPassed(input.deadlineIso, nowMs)) {
    return { stale: true, reason: 'follow-up-deadline-passed', ageMs };
  }

  switch (input.state) {
    case 'follow-up':
      // Already flagged to chase → act now.
      return { stale: true, reason: 'in-follow-up-state', ageMs };
    case 'waiting':
      if (ageMs !== null && ageMs >= waitingDays * MS_PER_DAY) {
        return { stale: true, reason: 'awaiting-reply-too-long', ageMs };
      }
      return { stale: false, ageMs };
    case 'needs-reply':
    case 'drafted':
      if (ageMs !== null && ageMs >= needsReplyDays * MS_PER_DAY) {
        return { stale: true, reason: 'unanswered-too-long', ageMs };
      }
      return { stale: false, ageMs };
    default:
      return { stale: false, ageMs };
  }
}
