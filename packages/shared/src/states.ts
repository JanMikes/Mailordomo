/**
 * Task-state transition table AS DATA (PLAN.md §7 Phase 1).
 *
 * This is the contract the Phase 3 state machine consumes: the allowed edges of the email-as-task
 * graph from PROJECT.md §6, each tagged with whether it is applied automatically (`auto`) or
 * proposed for human confirmation (`propose`). The state machine itself (validation, side effects,
 * IMAP-folder mirroring) lives in Phase 3 — this module is pure data + tiny lookups.
 *
 * PROJECT.md §6 graph:
 *   needs-reply ──▶ drafted ──▶ waiting ──▶ follow-up(+deadline) ──▶ done
 *        └──────────────── (no reply needed: "thanks") ────────────────▶ done
 *
 * §6 specifies two transitions as AUTO explicitly ("I sent → waiting"; inbound "thanks" → done).
 * The remaining edges below are the minimal forward path plus the realistic reopen/back edges; per
 * §6's rule ("auto-set obvious transitions, propose ambiguous ones") mechanical consequences of a
 * user/daemon action are `auto` and anything requiring judgement is `propose`. Each edge documents
 * its rationale so Phase 3 / the test author can confirm against intent.
 */
import type { TaskState, TransitionMode } from './enums';

/** A single allowed edge: the destination state and how it is applied. */
export interface TaskTransitionRule {
  readonly to: TaskState;
  readonly mode: TransitionMode;
}

/** The state a task enters when first created from a freshly-triaged inbound message. */
export const INITIAL_TASK_STATE: TaskState = 'needs-reply';

/**
 * `done` is the only resting/terminal state, but it is reopenable (a new inbound message on a
 * closed thread). "Terminal" here means "no further work is owed", not "immutable".
 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['done'];

/**
 * Allowed next-states per state, with mode. `as const satisfies …` proves the table is exhaustive
 * over every `TaskState` and that every `to`/`mode` is valid, while keeping literal types for
 * downstream exhaustiveness.
 */
export const TASK_STATE_TRANSITIONS = {
  // A draft was generated on signal → `drafted`; an inbound "thanks" needs no reply → `done`.
  'needs-reply': [
    { to: 'drafted', mode: 'auto' },
    { to: 'done', mode: 'auto' },
  ],
  // §6 explicit: the user sent the draft → `waiting`. Discarding the draft reopens → `needs-reply`.
  drafted: [
    { to: 'waiting', mode: 'auto' },
    { to: 'needs-reply', mode: 'propose' },
  ],
  // A follow-up deadline lapsed (stale detection) → `follow-up`. A reply that re-obligates me, or a
  // conclusion, are judgement calls → propose.
  waiting: [
    { to: 'follow-up', mode: 'auto' },
    { to: 'needs-reply', mode: 'propose' },
    { to: 'done', mode: 'propose' },
  ],
  // The sanctioned nudge draft was sent → back to `waiting`. Resolution / re-obligation → propose.
  'follow-up': [
    { to: 'waiting', mode: 'auto' },
    { to: 'needs-reply', mode: 'propose' },
    { to: 'done', mode: 'propose' },
  ],
  // A closed thread reopened by a new inbound message → `needs-reply` (a judgement call).
  done: [{ to: 'needs-reply', mode: 'propose' }],
} as const satisfies Record<TaskState, readonly TaskTransitionRule[]>;

/** Allowed outgoing edges from a state (empty array if the state somehow has none). */
export function allowedTransitions(from: TaskState): readonly TaskTransitionRule[] {
  return TASK_STATE_TRANSITIONS[from] ?? [];
}

/** The set of states reachable in one step from `from`. */
export function allowedNextStates(from: TaskState): readonly TaskState[] {
  return allowedTransitions(from).map((rule) => rule.to);
}

/** Whether `from → to` is an allowed edge. */
export function isAllowedTransition(from: TaskState, to: TaskState): boolean {
  return allowedTransitions(from).some((rule) => rule.to === to);
}

/** The mode of the `from → to` edge, or `undefined` if the edge is not allowed. */
export function transitionMode(from: TaskState, to: TaskState): TransitionMode | undefined {
  return allowedTransitions(from).find((rule) => rule.to === to)?.mode;
}
