/**
 * SMOKE — the do-next ranker (PROJECT.md §8). Thin coverage; the SEPARATE test-author writes the full
 * ordering suite (every step + tie permutations). Here we prove §8 steps 1→2→3 dominate in order and
 * that the Sonnet tie-break seam is SEPARATE, optional, and permutation-guarded.
 */
import { describe, expect, it } from 'vitest';
import { applyConsequenceTieBreak, breakTiesByConsequence, rankTasks } from './ranker';
import type { ConsequenceJudge, RankableTask } from './ranker';

const NOW = '2026-06-05T12:00:00Z';

function task(over: Partial<RankableTask> & { id: string }): RankableTask {
  return { importance: 'normal', myPromises: [], theyAsked: [], lastActivityIso: NOW, ...over };
}

describe('rankTasks — §8 priority order', () => {
  it('step 1: a task with an outstanding my-promise outranks a high-importance task without one', () => {
    const withPromise = task({
      id: 'promise',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: '2026-06-10T00:00:00Z' }],
    });
    const highImportance = task({ id: 'vip', importance: 'high' });
    const { ordered } = rankTasks([highImportance, withPromise], NOW);
    expect(ordered[0]).toBe('promise');
  });

  it('step 1 within: an overdue my-promise outranks a future one', () => {
    const overdue = task({
      id: 'late',
      myPromises: [{ status: 'overdue', due_at: '2026-06-01T00:00:00Z' }],
    });
    const future = task({
      id: 'soon',
      myPromises: [{ status: 'open', due_at: '2026-06-09T00:00:00Z' }],
    });
    const { ordered } = rankTasks([future, overdue], NOW);
    expect(ordered).toEqual(['late', 'soon']);
  });

  it('step 2: with no promises, higher importance wins', () => {
    const { ordered } = rankTasks(
      [task({ id: 'low', importance: 'low' }), task({ id: 'high', importance: 'high' })],
      NOW,
    );
    expect(ordered).toEqual(['high', 'low']);
  });

  it('step 3: equal importance, oldest activity first', () => {
    const { ordered } = rankTasks(
      [
        task({ id: 'newer', lastActivityIso: '2026-06-04T00:00:00Z' }),
        task({ id: 'older', lastActivityIso: '2026-06-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(ordered).toEqual(['older', 'newer']);
  });

  it('reports tie-groups for items equal on steps 1–3 and keeps input order (stable)', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const { ordered, tieGroups } = rankTasks([a, b], NOW);
    expect(ordered).toEqual(['a', 'b']);
    expect(tieGroups).toEqual([['a', 'b']]);
  });
});

describe('D26 — they-asked is a SECOND commitment tier (below my-promise, above importance)', () => {
  it('an UNDATED my-promise outranks an OVERDUE they-asked (my own commitments lead)', () => {
    const mine = task({
      id: 'mine',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: null }],
    });
    const owed = task({
      id: 'owed',
      importance: 'high',
      theyAsked: [{ status: 'overdue', due_at: '2026-06-01T00:00:00Z' }],
    });
    expect(rankTasks([owed, mine], NOW).ordered).toEqual(['mine', 'owed']);
  });

  it('a they-asked commitment outranks a plain high-importance task with no commitment', () => {
    const owed = task({
      id: 'owed',
      importance: 'low',
      theyAsked: [{ status: 'open', due_at: '2026-06-10T00:00:00Z' }],
    });
    const vip = task({ id: 'vip', importance: 'high' });
    expect(rankTasks([vip, owed], NOW).ordered).toEqual(['owed', 'vip']);
  });
});

describe('the Sonnet tie-break seam (step 4) — separate + permutation-guarded', () => {
  const reverseJudge: ConsequenceJudge = {
    order: (tied) => Promise.resolve([...tied].reverse()),
  };

  it('breakTiesByConsequence reorders a genuine tie via the judge', async () => {
    expect(await breakTiesByConsequence(['a', 'b', 'c'], reverseJudge)).toEqual(['c', 'b', 'a']);
  });

  it('rejects a judge that is not a permutation (keeps the deterministic order)', async () => {
    const badJudge: ConsequenceJudge = { order: () => Promise.resolve(['a', 'a']) };
    expect(await breakTiesByConsequence(['a', 'b'], badJudge)).toEqual(['a', 'b']);
  });

  it('applyConsequenceTieBreak splices each judged group back into the order', async () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const vip = task({ id: 'vip', importance: 'high' });
    const result = rankTasks([vip, a, b], NOW); // vip first (importance), then [a,b] tied
    const final = await applyConsequenceTieBreak(result, reverseJudge);
    expect(final).toEqual(['vip', 'b', 'a']);
  });

  it('no tie-groups ⇒ applyConsequenceTieBreak returns the deterministic order unchanged', async () => {
    const result = rankTasks(
      [task({ id: 'high', importance: 'high' }), task({ id: 'low', importance: 'low' })],
      NOW,
    );
    expect(await applyConsequenceTieBreak(result, reverseJudge)).toEqual(['high', 'low']);
  });
});
