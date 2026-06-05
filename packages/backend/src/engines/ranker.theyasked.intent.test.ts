/**
 * INTENT (separate test-author) — the D26 TWO-TIER do-next ranker (PROJECT.md §8 + PLAN.md D26).
 *
 * This suite is ADDITIVE to `ranker.smoke.test.ts` (it does not replace it). It pins the load-bearing
 * D26 invariant derived from the SPEC, not from the implementation: `my-promise` and `they-asked` are
 * SEPARATE commitment tiers, with `my-promise` ranking STRICTLY above `they-asked`, and BOTH above
 * sender importance. The shipped sort key is
 *   `[hasPromise, commitmentUrgency, hasTheyAsked, theyAskedUrgency, importanceWeight, ageMs]`.
 *
 * Two MUTATION CHECKS at the bottom prove the assertions are non-tautological: (1) MERGING the two
 * tiers inverts the load-bearing my-promise > they-asked order; (2) DROPPING the they-asked bands lets
 * sender importance beat an owed task. Each states exactly which invariant it pins.
 */
import { describe, expect, it } from 'vitest';
import { compareRankKeys, promiseTierKey, rankKey, rankTasks } from './ranker';
import type { RankableTask, RankKey } from './ranker';

const NOW = '2026-06-05T12:00:00.000Z';

// Deadlines relative to NOW, chosen so each lands in a distinct urgency band.
const PAST_FAR = '2026-05-26T12:00:00.000Z'; // now − 10d (most overdue)
const PAST_NEAR = '2026-06-04T12:00:00.000Z'; // now − 1d (less overdue)
const FUTURE_NEAR = '2026-06-06T12:00:00.000Z'; // now + 1d
const FUTURE_FAR = '2026-06-15T12:00:00.000Z'; // now + 10d

/** Build a RankableTask; defaults give an item with NO commitments, normal importance, zero age. */
function task(over: Partial<RankableTask> & { id: string }): RankableTask {
  return { importance: 'normal', myPromises: [], theyAsked: [], lastActivityIso: NOW, ...over };
}

describe('D26 — my-promise and they-asked are SEPARATE tiers (my-promise strictly above)', () => {
  it('THE load-bearing invariant: an UNDATED my-promise outranks an OVERDUE they-asked', () => {
    // Hardest case for the tier boundary: the WEAKEST my-promise (undated) vs the STRONGEST
    // they-asked (most overdue), with importance stacked AGAINST the my-promise. Tier wins anyway.
    const mine = task({
      id: 'mine',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: null }],
    });
    const owed = task({
      id: 'owed',
      importance: 'high',
      theyAsked: [{ status: 'overdue', due_at: PAST_FAR }],
    });
    expect(rankTasks([owed, mine], NOW).ordered).toEqual(['mine', 'owed']);
    // The separation is decided at the FIRST key component (`hasPromise`), before anything else.
    expect(compareRankKeys(rankKey(mine, NOW), rankKey(owed, NOW))).toBeLessThan(0);
  });

  it('a they-asked commitment outranks a no-commitment HIGH-importance task (tier beats importance)', () => {
    const owed = task({
      id: 'owed',
      importance: 'low',
      theyAsked: [{ status: 'open', due_at: FUTURE_FAR }],
    });
    const vip = task({ id: 'vip', importance: 'high' });
    expect(rankTasks([vip, owed], NOW).ordered).toEqual(['owed', 'vip']);
  });

  it('a my-promise outranks a they-asked even when the they-asked deadline is MORE urgent', () => {
    const mine = task({
      id: 'mine',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: FUTURE_FAR }], // far-future, low urgency
    });
    const owed = task({
      id: 'owed',
      importance: 'high',
      theyAsked: [{ status: 'overdue', due_at: PAST_FAR }], // very overdue, high urgency
    });
    expect(rankTasks([owed, mine], NOW).ordered).toEqual(['mine', 'owed']);
  });

  it('awaiting-them confers NO rank boost — it is not even a ranker input', () => {
    // `RankableTask` has only my-promise + they-asked channels (D26): the chase queue (`awaiting-them`)
    // deliberately has no projection here, so a "chase-only" thread is identical to a no-commitment one.
    const base = task({ id: 'base' });
    const chaseOnly = task({ id: 'chase' }); // awaiting-them projects to empty my/theyAsked
    const owes = task({ id: 'owes', theyAsked: [{ status: 'open', due_at: FUTURE_NEAR }] });

    expect(rankKey(base, NOW)).toEqual(rankKey(chaseOnly, NOW)); // identical keys
    // A real they-asked DOES break out of the importance/age tier; the "chase" item does not.
    expect(rankTasks([base, chaseOnly, owes], NOW).ordered).toEqual(['owes', 'base', 'chase']);
  });

  it('within the they-asked tier: overdue(most-late) > overdue(less-late) > sooner > later > undated', () => {
    const overFar = task({ id: 'overFar', theyAsked: [{ status: 'overdue', due_at: PAST_FAR }] });
    const overNear = task({
      id: 'overNear',
      theyAsked: [{ status: 'overdue', due_at: PAST_NEAR }],
    });
    const futNear = task({ id: 'futNear', theyAsked: [{ status: 'open', due_at: FUTURE_NEAR }] });
    const futFar = task({ id: 'futFar', theyAsked: [{ status: 'open', due_at: FUTURE_FAR }] });
    const undated = task({ id: 'undated', theyAsked: [{ status: 'open', due_at: null }] });

    // Same importance + same activity for all, so the they-asked urgency band is the sole discriminator.
    const { ordered } = rankTasks([undated, futFar, futNear, overNear, overFar], NOW);
    expect(ordered).toEqual(['overFar', 'overNear', 'futNear', 'futFar', 'undated']);
    // The SAME urgency function backs both tiers (D26): identical promises ⇒ identical tier key.
    const my = promiseTierKey([{ status: 'overdue', due_at: PAST_FAR }], NOW);
    const ta = promiseTierKey([{ status: 'overdue', due_at: PAST_FAR }], NOW);
    expect(my).toEqual(ta);
  });

  it('a task with BOTH my-promise and they-asked: the TOP tier ranks it identically to my-promise-only', () => {
    // "Higher tier dominates": the my-promise tier is INDIFFERENT to the they-asked tier — both items
    // share an identical [hasPromise, commitmentUrgency]. (Per D26's lexicographic key the they-asked
    // band then breaks the residual tie — the more-owed item surfaces first; see report note.)
    const both = task({
      id: 'both',
      myPromises: [{ status: 'open', due_at: FUTURE_FAR }],
      theyAsked: [{ status: 'overdue', due_at: PAST_FAR }],
    });
    const onlyMine = task({ id: 'onlyMine', myPromises: [{ status: 'open', due_at: FUTURE_FAR }] });

    const kBoth = rankKey(both, NOW);
    const kMine = rankKey(onlyMine, NOW);
    expect(kBoth.hasPromise).toBe(kMine.hasPromise); // top tier: present on both
    expect(kBoth.commitmentUrgency).toBe(kMine.commitmentUrgency); // top tier: indifferent
    // The they-asked tie-break then orders `both` first (D26 lexicographic), never below `onlyMine`.
    expect(compareRankKeys(kBoth, kMine)).toBeLessThan(0);
    expect(rankTasks([onlyMine, both], NOW).ordered).toEqual(['both', 'onlyMine']);
  });
});

describe('D26 mutation checks — prove the tier structure is load-bearing (non-tautological)', () => {
  it('MUTATION: merging the two tiers would INVERT my-promise > they-asked', () => {
    // PINS: strict tier separation (undated my-promise strictly above overdue they-asked).
    const mine = task({
      id: 'mine',
      importance: 'low',
      myPromises: [{ status: 'open', due_at: null }],
    });
    const owed = task({
      id: 'owed',
      importance: 'high',
      theyAsked: [{ status: 'overdue', due_at: PAST_FAR }],
    });

    // The REAL ranker keeps the my-promise first.
    expect(rankTasks([owed, mine], NOW).ordered[0]).toBe('mine');

    // A MERGED-tier mutant (single commitment band = max urgency across BOTH directions, the
    // pre-D26 "include them together" leaning) would rank the overdue they-asked FIRST — the bug.
    const mergedFirst = (a: RankableTask, b: RankableTask): string => {
      const band = (t: RankableTask): [number, number] => {
        const [hm, um] = promiseTierKey(t.myPromises, NOW);
        const [ht, ut] = promiseTierKey(t.theyAsked, NOW);
        const has = Math.max(hm, ht);
        const urg = Math.max(hm ? um : -Infinity, ht ? ut : -Infinity);
        return [has, urg];
      };
      const [ha, ua] = band(a);
      const [hb, ub] = band(b);
      if (ha !== hb) return ha > hb ? a.id : b.id;
      return ua >= ub ? a.id : b.id;
    };
    expect(mergedFirst(owed, mine)).toBe('owed'); // mutant: WRONG (they-asked wins)
    expect(rankTasks([owed, mine], NOW).ordered[0]).toBe('mine'); // real: RIGHT (my-promise wins)
  });

  it('MUTATION: dropping the they-asked bands would let importance beat an owed task', () => {
    // PINS: the they-asked tier exists and sits ABOVE sender importance.
    const owed = task({
      id: 'owed',
      importance: 'low',
      theyAsked: [{ status: 'open', due_at: FUTURE_FAR }],
    });
    const vip = task({ id: 'vip', importance: 'high' });
    const ko = rankKey(owed, NOW);
    const kv = rankKey(vip, NOW);

    // A comparator WITHOUT the two they-asked lines: hasPromise → commitmentUrgency → importance → age.
    const withoutTheyAsked = (a: RankKey, b: RankKey): number =>
      a.hasPromise !== b.hasPromise
        ? b.hasPromise - a.hasPromise
        : a.commitmentUrgency !== b.commitmentUrgency
          ? b.commitmentUrgency - a.commitmentUrgency
          : a.importanceWeight !== b.importanceWeight
            ? b.importanceWeight - a.importanceWeight
            : b.ageMs - a.ageMs;

    expect(withoutTheyAsked(ko, kv)).toBeGreaterThan(0); // mutant: vip (importance) sorts FIRST — WRONG
    expect(compareRankKeys(ko, kv)).toBeLessThan(0); // real: owed (they-asked) sorts FIRST — RIGHT
  });
});
