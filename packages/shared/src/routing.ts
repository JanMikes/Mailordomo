/**
 * Fixed model routing — PROJECT.md §4 and Golden rule #6.
 *
 * Routing is a constant, not a runtime decision: every Claude job kind maps to exactly one model
 * alias. Haiku = triage/extraction; Sonnet = summaries/digest/ranking; Opus = drafts & repo-aware
 * code answers. The load-bearing invariant — "never route outgoing-text generation below Opus" —
 * is encoded BOTH at compile time (the `OUTGOING_TEXT_MODELS` assignment below fails to typecheck
 * if violated) AND at runtime (`assertOutgoingTextRouting`, also run once on import).
 */
import type { ModelAlias, TaskKind } from './enums';

/**
 * Capability/cost ordering of the model aliases. Higher = more capable & more expensive. Used to
 * make "never below Opus" checkable: a kind routes "below opus" iff its rank < opus's rank.
 */
export const MODEL_RANK: Record<ModelAlias, number> = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
};

/** The top (most capable) rank — the floor for any outgoing-text generation. */
export const OPUS_RANK = MODEL_RANK.opus;

/**
 * Task kind → model alias. `as const satisfies Record<TaskKind, ModelAlias>` does double duty:
 *  - `satisfies` proves the map is EXHAUSTIVE over `TaskKind` and every value is a valid alias;
 *  - `as const` preserves the literal value types so the Golden-rule-#6 guard below can see that
 *    `draft`/`nudge` are literally `'opus'`.
 */
export const MODEL_ROUTING = {
  triage: 'haiku',
  'promise-extraction': 'haiku',
  summarize: 'sonnet',
  digest: 'sonnet',
  rank: 'sonnet',
  draft: 'opus',
  nudge: 'opus',
  'repo-answer': 'opus',
} as const satisfies Record<TaskKind, ModelAlias>;

/**
 * Task kinds whose output is model-GENERATED TEXT a human consumes, sends, or publishes — Golden
 * rule #6's "outgoing-text generation," which must never route below Opus. `draft` is a reply
 * draft; `nudge` is the one sanctioned auto-draft for a lapsed inbound promise; `repo-answer` is a
 * repo-aware technical answer. §4 and Golden rule #6 name "drafts & repo-aware code answers"
 * together as the Opus tier, so all three are guarded here (not just the ones that become email).
 */
export const OUTGOING_TEXT_TASK_KINDS = ['draft', 'nudge', 'repo-answer'] as const;
export type OutgoingTextTaskKind = (typeof OUTGOING_TEXT_TASK_KINDS)[number];

/**
 * COMPILE-TIME enforcement of Golden rule #6. This is typed to require `'opus'` for every outgoing
 * kind, and is populated FROM `MODEL_ROUTING`. If routing ever mapped `draft` or `nudge` below
 * Opus, the source value would no longer be the literal `'opus'` and this assignment would fail to
 * typecheck — breaking the build before any code can ship.
 */
export const OUTGOING_TEXT_MODELS: Record<OutgoingTextTaskKind, 'opus'> = {
  draft: MODEL_ROUTING.draft,
  nudge: MODEL_ROUTING.nudge,
  'repo-answer': MODEL_ROUTING['repo-answer'],
};

/** Resolve the model alias for a task kind. */
export function modelForTask(kind: TaskKind): ModelAlias {
  return MODEL_ROUTING[kind];
}

/**
 * RUNTIME enforcement of Golden rule #6, for any routing map (e.g. a future user-tuned one):
 * throws if any outgoing-text task kind is routed below Opus. Pure and checkable; the test suite
 * asserts both the happy path and that a tampered map throws.
 */
export function assertOutgoingTextRouting(
  routing: Record<TaskKind, ModelAlias> = MODEL_ROUTING,
): void {
  for (const kind of OUTGOING_TEXT_TASK_KINDS) {
    const alias = routing[kind];
    if (MODEL_RANK[alias] < OPUS_RANK) {
      throw new Error(
        `Golden rule #6 violated: outgoing-text task "${kind}" routes to "${alias}", below opus.`,
      );
    }
  }
}

// Self-check on import: the default routing must always satisfy Golden rule #6.
assertOutgoingTextRouting();
