/**
 * INTENT-DERIVED suite for the do-next RANKER (PROJECT.md §8). Derived from the spec's exact priority
 * order — 1. promises I made → 2. sender importance → 3. age/staleness → 4. Sonnet consequence
 * (tie-break ONLY) — and the invariant that step 4 may reorder NOTHING but a genuine 1–3 tie.
 * Complements `ranker.smoke.test.ts` with step-dominance, the actionable-promise filter, the
 * maximally-stale null case, stable ordering, and the permutation guard's three distinct failure modes.
 */
import { describe, expect, it } from 'vitest';
import { applyConsequenceTieBreak, breakTiesByConsequence, rankTasks } from './ranker';
import type { ConsequenceJudge, RankableTask } from './ranker';

const NOW = '2026-06-05T12:00:00Z';
const DAY = 86_400_000;
const fromNow = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

function task(over: Partial<RankableTask> & { id: string }): RankableTask {
  return { importance: 'normal', myPromises: [], lastActivityIso: NOW, ...over };
}

const order = (tasks: readonly RankableTask[]): readonly string[] => rankTasks(tasks, NOW).ordered;

describe('§8 step 1 (my promises) dominates step 2 (importance)', () => {
  it('even an UNDATED, low-importance commitment outranks a high-importance task with no commitment', () => {
    const commit = task({
      id: 'commit',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: null }],
    });
    const vip = task({ id: 'vip', importance: 'high' });
    expect(order([vip, commit])).toEqual(['commit', 'vip']);
  });

  it('only ACTIONABLE (open/overdue) promises count — fulfilled/cancelled fall back to importance', () => {
    const live = task({ id: 'live', myPromises: [{ status: 'open', due_at: fromNow(5 * DAY) }] });
    const fulfilledHigh = task({
      id: 'fulfilled-high',
      importance: 'high',
      myPromises: [{ status: 'fulfilled', due_at: fromNow(-DAY) }],
    });
    const cancelledNormal = task({
      id: 'cancelled-normal',
      myPromises: [{ status: 'cancelled', due_at: fromNow(-DAY) }],
    });
    const plainLow = task({ id: 'plain-low', importance: 'low' });
    // live is the only task with an actionable commitment → 1st; the rest rank by importance only.
    expect(order([fulfilledHigh, plainLow, cancelledNormal, live])).toEqual([
      'live',
      'fulfilled-high',
      'cancelled-normal',
      'plain-low',
    ]);
  });
});

describe('§8 step 1 internal urgency: overdue (most-late) > sooner-future > later-future > undated', () => {
  it('orders commitments by deadline urgency', () => {
    const overdue10 = task({
      id: 'overdue10',
      myPromises: [{ status: 'overdue', due_at: fromNow(-10 * DAY) }],
    });
    const overdue1 = task({
      id: 'overdue1',
      myPromises: [{ status: 'overdue', due_at: fromNow(-DAY) }],
    });
    const soon = task({ id: 'soon', myPromises: [{ status: 'open', due_at: fromNow(DAY) }] });
    const later = task({
      id: 'later',
      myPromises: [{ status: 'open', due_at: fromNow(10 * DAY) }],
    });
    const undated = task({ id: 'undated', myPromises: [{ status: 'open', due_at: null }] });
    expect(order([undated, soon, overdue1, later, overdue10])).toEqual([
      'overdue10',
      'overdue1',
      'soon',
      'later',
      'undated',
    ]);
  });
});

describe('§8 steps 2 and 3 break a step-1 tie, in that order', () => {
  it('equal commitment urgency → higher importance first (step 2)', () => {
    const due = fromNow(-DAY);
    const high = task({
      id: 'imp-high',
      importance: 'high',
      myPromises: [{ status: 'overdue', due_at: due }],
    });
    const low = task({
      id: 'imp-low',
      importance: 'low',
      myPromises: [{ status: 'overdue', due_at: due }],
    });
    expect(order([low, high])).toEqual(['imp-high', 'imp-low']);
  });

  it('equal commitment + importance → older last-activity first (step 3)', () => {
    const due = fromNow(-DAY);
    const older = task({
      id: 'older',
      lastActivityIso: fromNow(-5 * DAY),
      myPromises: [{ status: 'overdue', due_at: due }],
    });
    const newer = task({
      id: 'newer',
      lastActivityIso: fromNow(-DAY),
      myPromises: [{ status: 'overdue', due_at: due }],
    });
    expect(order([newer, older])).toEqual(['older', 'newer']);
  });

  it('a null last-activity is treated as MAXIMALLY stale (surfaces first on age)', () => {
    const unknown = task({ id: 'unknown', lastActivityIso: null });
    const recent = task({ id: 'recent', lastActivityIso: fromNow(-DAY) });
    expect(order([recent, unknown])).toEqual(['unknown', 'recent']);
  });
});

describe('determinism: tie-groups + stable order', () => {
  it('reports NO tie-groups when every key is distinct', () => {
    const result = rankTasks(
      [
        task({ id: 'high', importance: 'high' }),
        task({ id: 'normal', importance: 'normal' }),
        task({ id: 'low', importance: 'low' }),
      ],
      NOW,
    );
    expect(result.tieGroups).toEqual([]);
    expect(result.ordered).toEqual(['high', 'normal', 'low']);
  });

  it('groups only the genuinely-equal run (≥2) and leaves a distinct leader out of it', () => {
    const result = rankTasks(
      [
        task({ id: 'vip', importance: 'high' }),
        task({ id: 'a' }),
        task({ id: 'b' }),
        task({ id: 'c' }),
      ],
      NOW,
    );
    expect(result.ordered).toEqual(['vip', 'a', 'b', 'c']);
    expect(result.tieGroups).toEqual([['a', 'b', 'c']]);
  });

  it('is a STABLE sort: equal keys keep input order (not id-sorted)', () => {
    expect(order([task({ id: 'z' }), task({ id: 'a' })])).toEqual(['z', 'a']);
  });
});

describe('§8 step 4 seam — reorders ONLY a tie, validated as a permutation', () => {
  const reverse: ConsequenceJudge = { order: (tied) => Promise.resolve([...tied].reverse()) };

  it('applies a genuine permutation from the judge', async () => {
    expect(await breakTiesByConsequence(['a', 'b', 'c'], reverse)).toEqual(['c', 'b', 'a']);
  });

  it('never invokes the judge for a group smaller than 2 (nothing to break)', async () => {
    let calls = 0;
    const counting: ConsequenceJudge = {
      order: (tied) => {
        calls += 1;
        return Promise.resolve([...tied]);
      },
    };
    expect(await breakTiesByConsequence(['solo'], counting)).toEqual(['solo']);
    expect(await breakTiesByConsequence([], counting)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('REJECTS a non-permutation judge (drop / add / invent / duplicate) and keeps deterministic order', async () => {
    const drop: ConsequenceJudge = { order: (tied) => Promise.resolve(tied.slice(0, -1)) };
    const add: ConsequenceJudge = { order: (tied) => Promise.resolve([...tied, 'EXTRA']) };
    const invent: ConsequenceJudge = { order: () => Promise.resolve(['a', 'b', 'GHOST']) };
    const duplicate: ConsequenceJudge = { order: () => Promise.resolve(['a', 'a', 'b']) };
    for (const judge of [drop, add, invent, duplicate]) {
      expect(await breakTiesByConsequence(['a', 'b', 'c'], judge)).toEqual(['a', 'b', 'c']);
    }
  });

  it('applyConsequenceTieBreak reorders the tie-group ONLY, leaving the rest of the order intact', async () => {
    const result = rankTasks(
      [
        task({ id: 'vip', importance: 'high' }),
        task({ id: 'a' }),
        task({ id: 'b' }),
        task({ id: 'c' }),
      ],
      NOW,
    );
    expect(await applyConsequenceTieBreak(result, reverse)).toEqual(['vip', 'c', 'b', 'a']);
  });

  it('applyConsequenceTieBreak is a no-op when there are no ties to break', async () => {
    const result = rankTasks(
      [task({ id: 'high', importance: 'high' }), task({ id: 'low', importance: 'low' })],
      NOW,
    );
    expect(await applyConsequenceTieBreak(result, reverse)).toEqual(['high', 'low']);
  });
});
