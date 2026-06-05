/**
 * Display vocabularies — the single place that maps the shared enums to UI copy + styling. Sentence
 * case throughout (CLAUDE.md). The bright semantic hues are RESERVED for the three promise directions
 * (PROJECT.md §7); task-state dots use a quieter palette so the promise colors stay the signal.
 */
import type { PromiseDirection, StaleReason, TaskState, UrgencyLabel } from '@mailordomo/shared';

/** Canonical display order for the three promise directions (PROJECT.md §7: deliver → owe → chase). */
export const PROMISE_ORDER: readonly PromiseDirection[] = [
  'my-promise',
  'they-asked',
  'awaiting-them',
];

/** Task-state badge label (sentence case). */
export const STATE_LABEL: Record<TaskState, string> = {
  'needs-reply': 'Needs reply',
  drafted: 'Drafted',
  waiting: 'Waiting',
  'follow-up': 'Follow-up',
  done: 'Done',
};

/** Quiet status-dot color per state (NOT the promise hues). */
export const STATE_DOT_CLASS: Record<TaskState, string> = {
  'needs-reply': 'bg-amber-500',
  drafted: 'bg-sky-500',
  waiting: 'bg-zinc-400',
  'follow-up': 'bg-orange-500',
  done: 'bg-emerald-500',
};

export interface PromiseMeta {
  /** Direction name, e.g. "My promises". */
  label: string;
  /** The action it implies, e.g. "Deliver" / "You owe" / "Chase". */
  action: string;
  /** Solid fill for the direction dot (`bg-promise-*`). */
  dotClass: string;
  /** Direction text/icon color (`text-promise-*`). */
  textClass: string;
  /** Subtle tinted background (the direction hue at 10% alpha) for the metric icon chip. */
  tintClass: string;
}

/**
 * Per-direction display + color. The three `--color-promise-*` tokens (light/dark aware) drive every
 * promise visual: the metric cards and the per-card direction dots.
 */
export const PROMISE_META: Record<PromiseDirection, PromiseMeta> = {
  'my-promise': {
    label: 'My promises',
    action: 'Deliver',
    dotClass: 'bg-promise-deliver',
    textClass: 'text-promise-deliver',
    tintClass: 'bg-promise-deliver/10',
  },
  'they-asked': {
    label: 'They asked',
    action: 'You owe',
    dotClass: 'bg-promise-owe',
    textClass: 'text-promise-owe',
    tintClass: 'bg-promise-owe/10',
  },
  'awaiting-them': {
    label: 'Awaiting them',
    action: 'Chase',
    dotClass: 'bg-promise-chase',
    textClass: 'text-promise-chase',
    tintClass: 'bg-promise-chase/10',
  },
};

/** Categorical urgency copy (used in tooltips / a11y labels; the chip itself shows the date). */
export const URGENCY_LABEL: Record<UrgencyLabel, string> = {
  overdue: 'Overdue',
  'due-soon': 'Due soon',
  dated: 'Upcoming',
  undated: 'No deadline',
};

/** Stale-reason copy (PROJECT.md §9 stale-thread nudge). */
export const STALE_LABEL: Record<StaleReason, string> = {
  'follow-up-deadline-passed': 'Follow-up overdue',
  'awaiting-reply-too-long': 'No reply yet',
  'in-follow-up-state': 'Time to follow up',
  'unanswered-too-long': 'Unanswered too long',
};
