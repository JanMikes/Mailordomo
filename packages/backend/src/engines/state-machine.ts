/**
 * Email-as-task state machine — a PURE engine (no IO).
 *
 * It is a thin, faithful interpreter over the shared transition table
 * ({@link TASK_STATE_TRANSITIONS} in `@mailordomo/shared`), which is the single source of truth for
 * the legal edges of PROJECT.md §6's graph and whether each edge is applied automatically (`auto`)
 * or proposed for human confirmation (`propose`). This module adds NO new edges and NO new modes —
 * it only (a) validates a candidate transition and (b) maps a semantic event to the next state,
 * deferring legality + mode entirely to the shared table. That is what makes "auto-set the obvious,
 * propose the ambiguous" (§6) provable from the data the test author already has.
 */
import type { TaskState, TransitionMode } from '@mailordomo/shared';
import { transitionMode } from '@mailordomo/shared';

/**
 * The semantic events the rest of the system raises. Each names a concrete signal; the *target*
 * state it implies is fixed (below), while the *from* state decides legality + mode via the shared
 * table. Names match the orchestrator's vocabulary (`user-sent`, `inbound-thanks`,
 * `deadline-lapsed`, `new-inbound`, …).
 */
export const TASK_EVENTS = [
  'draft-created',
  'user-sent',
  'inbound-thanks',
  'deadline-lapsed',
  'new-inbound',
  'draft-discarded',
  'mark-done',
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

/**
 * The state each event drives toward. Legality from a given `from` state, and whether the move is
 * `auto` or `propose`, are NOT encoded here — they come from the shared table, so this map can only
 * ever express intent, never override the contract.
 *  - `draft-created`   → drafted     (a draft was generated on signal)
 *  - `user-sent`       → waiting     (§6 explicit auto: I sent → waiting; also a sent nudge)
 *  - `inbound-thanks`  → done        (§6 explicit auto from needs-reply; a judgement call elsewhere)
 *  - `deadline-lapsed` → follow-up   (a `waiting` follow-up deadline passed)
 *  - `new-inbound`     → needs-reply (a new message re-obligates / reopens the thread)
 *  - `draft-discarded` → needs-reply (the draft was thrown away)
 *  - `mark-done`       → done        (explicit close)
 */
const EVENT_TARGET: Record<TaskEvent, TaskState> = {
  'draft-created': 'drafted',
  'user-sent': 'waiting',
  'inbound-thanks': 'done',
  'deadline-lapsed': 'follow-up',
  'new-inbound': 'needs-reply',
  'draft-discarded': 'needs-reply',
  'mark-done': 'done',
};

/** Target state for an event (the fixed intent; legality is decided against the shared table). */
export function eventTargetState(event: TaskEvent): TaskState {
  return EVENT_TARGET[event];
}

/** The verdict of validating a candidate `from → to` transition directly against the table. */
export interface TransitionEvaluation {
  readonly from: TaskState;
  readonly to: TaskState;
  /** Whether the edge exists in the shared table at all. */
  readonly allowed: boolean;
  /** The edge's mode, or `undefined` when the edge is not allowed. */
  readonly mode: TransitionMode | undefined;
  /** Convenience: `true` iff the edge is allowed AND `auto`. */
  readonly auto: boolean;
}

/**
 * Validate a candidate transition. Pure lookup against the shared table — no side effects, no IMAP.
 * `allowed === false` ⇒ the move is illegal and must be rejected by the caller.
 */
export function evaluateTransition(from: TaskState, to: TaskState): TransitionEvaluation {
  const mode = transitionMode(from, to);
  return { from, to, allowed: mode !== undefined, mode, auto: mode === 'auto' };
}

/** Why an event produced no transition. */
export type NoopReason = 'already-in-target' | 'no-legal-transition';

/**
 * The outcome of feeding an event to the machine:
 *  - `apply`   — the edge exists and is `auto`: apply it immediately, attributing to the daemon.
 *  - `propose` — the edge exists and is `propose`: surface it for the human to confirm (§6).
 *  - `noop`    — no move: either already in the target state, or the event has no legal edge from
 *                here (e.g. `user-sent` while `needs-reply`, which has no direct edge to `waiting`).
 */
export type TransitionOutcome =
  | {
      readonly kind: 'apply';
      readonly from: TaskState;
      readonly to: TaskState;
      readonly event: TaskEvent;
      readonly mode: 'auto';
    }
  | {
      readonly kind: 'propose';
      readonly from: TaskState;
      readonly to: TaskState;
      readonly event: TaskEvent;
      readonly mode: 'propose';
    }
  | {
      readonly kind: 'noop';
      readonly from: TaskState;
      readonly event: TaskEvent;
      readonly reason: NoopReason;
    };

/**
 * Compute the machine's response to an event from a given state. Faithful to the shared table: the
 * event fixes the target, the table decides legality and auto-vs-propose. Obvious mechanical
 * consequences come back as `apply`; ambiguous ones as `propose`; everything else as `noop`.
 */
export function resolveEvent(from: TaskState, event: TaskEvent): TransitionOutcome {
  const to = EVENT_TARGET[event];
  if (from === to) {
    return { kind: 'noop', from, event, reason: 'already-in-target' };
  }
  const mode = transitionMode(from, to);
  if (mode === undefined) {
    return { kind: 'noop', from, event, reason: 'no-legal-transition' };
  }
  if (mode === 'auto') {
    return { kind: 'apply', from, to, event, mode };
  }
  return { kind: 'propose', from, to, event, mode };
}
