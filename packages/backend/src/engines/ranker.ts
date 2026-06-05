/**
 * The "do-next" RANKER — a PURE engine (no IO, no wall clock; "now" is injected).
 *
 * It implements PROJECT.md §8's priority order (with the D26 second commitment tier folded in), as a
 * total ordering over task items:
 *   1. PROMISES/DEADLINES I MADE   — commitments first (an item with an open/overdue `my-promise`,
 *      most-overdue / soonest-due first).
 *   1b. THEY ASKED OF ME (D26)     — their requests/deadlines of me ("I owe") form a SECOND tier
 *      between step 1 and step 2: strictly BELOW my own promises, strictly ABOVE sender importance.
 *      `awaiting-them` is NOT a tier (it drives the chase queue, not "what I must deliver").
 *   2. SENDER IMPORTANCE           — paying clients > internal > newsletters (`high > normal > low`).
 *   3. AGE / STALENESS             — oldest unanswered first (largest age wins).
 *   4. CLAUDE'S CONSEQUENCE        — what hurts most if ignored. This is a Sonnet TIE-BREAK ONLY and
 *      lives behind a SEPARATE, optional seam (`breakTiesByConsequence`) so steps 1–3 are fully
 *      deterministic and unit-testable with no API. The deterministic core NEVER calls a model.
 *
 * §8 is "mostly deterministic code over metadata; the model is used only to break ties at step 4."
 * So `rankTasks` returns BOTH the sorted list AND the residual tie-groups (items equal on 1–3) the
 * caller MAY hand to the model. Sender importance is an INPUT (seeded heuristically + stored in the
 * metadata service per §8/D14); the ranker does not compute it.
 */
import type { Importance, PromiseRecord, ThreadId } from '@mailordomo/shared';

/**
 * The minimal shape the ranker needs per candidate task. Deliberately decoupled from the stored
 * `Task` entity so the ranker is a pure function of just the ranking inputs (the caller projects a
 * Task + its thread + its promises into this).
 */
export interface RankableTask {
  /** Stable identity (for tie-group reporting + the optional model tie-break). */
  readonly id: ThreadId;
  /** Sender/task importance from the metadata service (§8 step 2). */
  readonly importance: Importance;
  /**
   * The MY-PROMISE records attached to this task (`my-promise` direction). Used for §8 step 1
   * (commitments I made — the TOP tier). An empty list ⇒ no commitment I made is outstanding on this
   * task. Only actionable (`open`/`overdue`) records count; each carries the resolved `due_at`
   * (may be null = no date).
   */
  readonly myPromises: readonly Pick<PromiseRecord, 'status' | 'due_at'>[];
  /**
   * The THEY-ASKED records attached to this task (`they-asked` direction — their request/deadline of
   * me, "I owe"). This is the SECOND commitment tier (D26): it ranks strictly BELOW `myPromises` and
   * strictly ABOVE sender importance, so my own commitments always lead their requests. Same shape
   * and actionable filter as {@link myPromises}. `awaiting-them` is deliberately NOT here — it drives
   * the chase queue, never the "what I must deliver" rank.
   */
  readonly theyAsked: readonly Pick<PromiseRecord, 'status' | 'due_at'>[];
  /**
   * When the thread last had activity (ISO-8601), for §8 step 3 (oldest-first). Null = unknown, which
   * sorts as the OLDEST (an item with no known activity is treated as maximally stale so it surfaces).
   */
  readonly lastActivityIso: string | null;
}

/** Importance → numeric weight; higher sorts first (§8 step 2). */
const IMPORTANCE_WEIGHT: Record<Importance, number> = { high: 2, normal: 1, low: 0 };

/** A promise counts for step 1 iff it is still actionable. `fulfilled`/`cancelled` do not. */
function isActionable(p: Pick<PromiseRecord, 'status'>): boolean {
  return p.status === 'open' || p.status === 'overdue';
}

/**
 * The "urgency" key for ONE commitment tier — a set of same-direction promises (my-promises OR
 * they-asked), derived ONLY from those promises. Reused for BOTH tiers (D26) so the two bands compute
 * urgency identically; only their POSITION in {@link RankKey} differs (my-promises above they-asked):
 *  - a tier with NO actionable promise ranks BELOW any tier that has one (commitments come first);
 *  - among tiers that have one, the one with the most-urgent deadline ranks first:
 *      · an OVERDUE promise (resolved `due_at` in the past) is most urgent — the further past, the
 *        more urgent (largest lateness first);
 *      · then a promise with a SOONER future `due_at`;
 *      · then a promise with NO date (a commitment exists but is undated).
 *
 * Returned as a comparable tuple `[hasPromise, urgency]` where a HIGHER tuple sorts first.
 *  `urgency` encodes: overdue → large positive (lateness ms); dated-future → negative (−msUntilDue,
 *  so sooner = larger); undated → a fixed sentinel just below any dated-future value.
 */
export function promiseTierKey(
  promises: readonly Pick<PromiseRecord, 'status' | 'due_at'>[],
  nowIso: string,
): [number, number] {
  const now = Date.parse(nowIso);
  const actionable = promises.filter(isActionable);
  if (actionable.length === 0) {
    return [0, 0];
  }

  let best = -Infinity;
  for (const promise of actionable) {
    if (promise.due_at === null) {
      // Undated commitment: a small finite urgency below any dated one (see UNDATED below).
      best = Math.max(best, UNDATED_URGENCY);
      continue;
    }
    const due = Date.parse(promise.due_at);
    if (Number.isNaN(due)) {
      best = Math.max(best, UNDATED_URGENCY);
      continue;
    }
    const msFromNow = due - now; // negative ⇒ overdue
    // Overdue: lateness is positive and dominates (offset above the dated-future band).
    // Future: sooner (smaller msFromNow) ⇒ larger urgency ⇒ use −msFromNow.
    const urgency = msFromNow < 0 ? OVERDUE_BASE + -msFromNow : -msFromNow;
    best = Math.max(best, urgency);
  }
  // If we only ever saw undated/unparseable promises, `best` is UNDATED_URGENCY; that's fine.
  return [1, best];
}

/** Sentinel urgencies. Overdue values sit ABOVE the future band; undated sits BELOW it. */
const OVERDUE_BASE = 1e15; // larger than any realistic −msFromNow for a future date
const UNDATED_URGENCY = -1e15; // below any realistic dated-future urgency (−msFromNow)

/** The age (ms) of a task for §8 step 3 — larger = older = ranks first. Null activity = oldest. */
export function ageMs(task: RankableTask, nowIso: string): number {
  if (task.lastActivityIso === null) {
    return Number.POSITIVE_INFINITY;
  }
  const last = Date.parse(task.lastActivityIso);
  if (Number.isNaN(last)) {
    return Number.POSITIVE_INFINITY;
  }
  return Date.parse(nowIso) - last;
}

/**
 * The full deterministic sort key for a task, as a tuple compared left→right, each component
 * "higher sorts first": `[hasPromise, commitmentUrgency, hasTheyAsked, theyAskedUrgency,
 * importanceWeight, ageMs]`. This is PROJECT.md §8 with the D26 second commitment tier inserted
 * between step 1 (my-promise) and step 2 (importance): my own commitments rank STRICTLY above their
 * requests, and both rank above sender importance. Step 4 (consequence) is intentionally NOT here.
 */
export interface RankKey {
  /** 1 iff an actionable my-promise exists (§8 step 1, top tier). */
  readonly hasPromise: number;
  /** Most-urgent my-promise deadline urgency (see {@link promiseTierKey}). */
  readonly commitmentUrgency: number;
  /** 1 iff an actionable they-asked promise exists (D26 second tier). */
  readonly hasTheyAsked: number;
  /** Most-urgent they-asked deadline urgency (see {@link promiseTierKey}). */
  readonly theyAskedUrgency: number;
  /** Sender/task importance weight (§8 step 2). */
  readonly importanceWeight: number;
  /** Age since last activity (§8 step 3); larger = older = ranks first. */
  readonly ageMs: number;
}

export function rankKey(task: RankableTask, nowIso: string): RankKey {
  const [hasPromise, commitmentUrgency] = promiseTierKey(task.myPromises, nowIso);
  const [hasTheyAsked, theyAskedUrgency] = promiseTierKey(task.theyAsked, nowIso);
  return {
    hasPromise,
    commitmentUrgency,
    hasTheyAsked,
    theyAskedUrgency,
    importanceWeight: IMPORTANCE_WEIGHT[task.importance],
    ageMs: ageMs(task, nowIso),
  };
}

/**
 * Compare two rank keys. Returns <0 if `a` should sort BEFORE `b` (a is higher priority). The band
 * order is §8 + D26: my-promise (has → urgency) → they-asked (has → urgency) → importance → age.
 * Because `hasPromise` is compared FIRST, an UNDATED my-promise task always beats even an OVERDUE
 * they-asked task — my commitments are strictly above their requests (D26's load-bearing invariant).
 */
export function compareRankKeys(a: RankKey, b: RankKey): number {
  if (a.hasPromise !== b.hasPromise) return b.hasPromise - a.hasPromise;
  if (a.commitmentUrgency !== b.commitmentUrgency) return b.commitmentUrgency - a.commitmentUrgency;
  if (a.hasTheyAsked !== b.hasTheyAsked) return b.hasTheyAsked - a.hasTheyAsked;
  if (a.theyAskedUrgency !== b.theyAskedUrgency) return b.theyAskedUrgency - a.theyAskedUrgency;
  if (a.importanceWeight !== b.importanceWeight) return b.importanceWeight - a.importanceWeight;
  if (a.ageMs !== b.ageMs) return b.ageMs - a.ageMs;
  return 0;
}

/** Two tasks are TIED iff steps 1–3 give an identical key (the only place step 4 may apply). */
export function tiedOnDeterministic(a: RankKey, b: RankKey): boolean {
  return compareRankKeys(a, b) === 0;
}

/** The result of the deterministic rank: the ordered ids + the residual tie-groups (size ≥ 2). */
export interface RankResult {
  /** Task ids in do-next order. Among items tied on §8 steps 1–3, INPUT ORDER is preserved (stable). */
  readonly ordered: readonly ThreadId[];
  /**
   * Groups of ids that are EQUAL on steps 1–3 (contiguous in `ordered`), each of size ≥ 2. These are
   * exactly the sets §8 step 4 (the Sonnet consequence tie-break) may reorder — and nothing else.
   */
  readonly tieGroups: readonly (readonly ThreadId[])[];
}

/**
 * Rank tasks by §8 steps 1–3 deterministically. STABLE: ties preserve input order (so the result is
 * reproducible and the optional model step is the ONLY source of non-determinism). Returns the order
 * plus the residual tie-groups for the caller to optionally resolve via {@link breakTiesByConsequence}.
 */
export function rankTasks(tasks: readonly RankableTask[], nowIso: string): RankResult {
  const keyed = tasks.map((task, index) => ({ task, index, key: rankKey(task, nowIso) }));
  keyed.sort((a, b) => {
    const byKey = compareRankKeys(a.key, b.key);
    return byKey !== 0 ? byKey : a.index - b.index; // stable: original order breaks equal keys
  });

  const ordered = keyed.map((entry) => entry.task.id);

  // Collect contiguous runs of equal keys (size ≥ 2) as tie-groups.
  const tieGroups: ThreadId[][] = [];
  let run: ThreadId[] = [];
  for (let i = 0; i < keyed.length; i += 1) {
    const current = keyed[i];
    const previous = keyed[i - 1];
    if (current === undefined) continue;
    if (previous !== undefined && tiedOnDeterministic(previous.key, current.key)) {
      if (run.length === 0) {
        const prevId = previous.task.id;
        run.push(prevId);
      }
      run.push(current.task.id);
    } else {
      if (run.length >= 2) tieGroups.push(run);
      run = [];
    }
  }
  if (run.length >= 2) tieGroups.push(run);

  return { ordered, tieGroups };
}

/**
 * The §8-step-4 SONNET TIE-BREAK SEAM — SEPARATE and OPTIONAL. Given a still-tied set of task ids
 * (one of {@link RankResult.tieGroups}) and a judge that returns those ids in consequence order
 * (most-consequential-if-ignored first), produce the reordered set. The judge is where the model
 * call happens; this function does the pure splice so the deterministic core stays API-free. The
 * caller substitutes each tie-group in `ordered` with the judge's ordering.
 *
 * Defensive: the judge's output is validated to be a PERMUTATION of the input (same multiset of ids);
 * on any mismatch the original (deterministic, input-order) ordering is kept — the model can only
 * reorder a genuine tie, never add, drop, or invent an id.
 */
export interface ConsequenceJudge {
  /** Return `tied` reordered most-consequential-first. Implemented by a Sonnet call upstream. */
  order(tied: readonly ThreadId[]): Promise<readonly ThreadId[]>;
}

export async function breakTiesByConsequence(
  tied: readonly ThreadId[],
  judge: ConsequenceJudge,
): Promise<ThreadId[]> {
  if (tied.length < 2) return [...tied];
  const judged = await judge.order(tied);
  if (!isPermutation(tied, judged)) {
    return [...tied];
  }
  return [...judged];
}

/**
 * Apply a consequence judge to EVERY tie-group of a {@link RankResult}, splicing each judged ordering
 * back into `ordered`. Convenience over `breakTiesByConsequence`; still API-free itself (the judge
 * owns the model call). Returns a fully-ordered id list.
 */
export async function applyConsequenceTieBreak(
  result: RankResult,
  judge: ConsequenceJudge,
): Promise<ThreadId[]> {
  if (result.tieGroups.length === 0) {
    return [...result.ordered];
  }
  // Resolve each tie-group, then walk `ordered` replacing each group's run with the judged order.
  const resolved = new Map<string, readonly ThreadId[]>();
  for (const group of result.tieGroups) {
    const firstId = group[0];
    if (firstId === undefined) continue;
    resolved.set(firstId, await breakTiesByConsequence(group, judge));
  }

  const out: ThreadId[] = [];
  let i = 0;
  while (i < result.ordered.length) {
    const id = result.ordered[i];
    if (id === undefined) {
      i += 1;
      continue;
    }
    const group = resolved.get(id);
    if (group !== undefined) {
      out.push(...group);
      i += group.length;
    } else {
      out.push(id);
      i += 1;
    }
  }
  return out;
}

/** True iff `b` is a permutation (same multiset) of `a`. Used to validate a judge's output. */
function isPermutation(a: readonly ThreadId[], b: readonly ThreadId[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<ThreadId, number>();
  for (const id of a) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const id of b) {
    const next = (counts.get(id) ?? 0) - 1;
    if (next < 0) return false;
    counts.set(id, next);
  }
  return true;
}
