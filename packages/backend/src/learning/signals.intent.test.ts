/**
 * INTENT-DERIVED suite for the two silent-learning SIGNALS (PROJECT.md §6: "Claude updates tone-memory
 * markdown from (a) recurring draft instructions and (b) the diff between its draft and what the user
 * actually sent"). Written from the SPEC, additive to the implementer's `learning.smoke.test.ts`.
 *
 * Invariants pinned:
 *  - `recurringInstructions` flags guidance that RECURS (default threshold 2), NORMALIZES case +
 *    whitespace so trivial variants group, IGNORES a one-off, and is deterministic (most-frequent
 *    first, ties by first appearance), returning the first-seen original spelling.
 *  - `draftVsSentDiff` is a DETERMINISTIC line diff capturing the meaningful draft→sent delta (added =
 *    sent-only, removed = draft-only, unchanged count, `changed` flag); an unedited send ⇒ not changed.
 *
 * MUTATION CHECK (pins "recurrence threshold + normalization"): drop the normalization (compare raw)
 * and `groups case/whitespace variants of the same instruction` FAILS; lower the default threshold to 1
 * and `does NOT flag a one-off instruction` FAILS. Verified by reasoning.
 */
import { describe, expect, it } from 'vitest';
import {
  draftVsSentDiff,
  recurringInstructions,
  renderDiffSummary,
  type DiffSummary,
} from './signals';

describe('recurringInstructions — promote guidance the user keeps typing (PROJECT.md §6a)', () => {
  it('does NOT flag a one-off instruction (a single occurrence is not a durable signal)', () => {
    expect(recurringInstructions(['please CC my manager this once'])).toEqual([]);
    expect(recurringInstructions(['keep it short', 'no emoji', 'be warm'])).toEqual([]);
  });

  it('flags an instruction once it recurs at the default threshold (≥ 2)', () => {
    expect(recurringInstructions(['keep it short', 'keep it short'])).toEqual(['keep it short']);
  });

  it('groups case/whitespace variants of the SAME instruction (normalization), keeping count', () => {
    // Three normalized-identical variants + one distinct one-off → only the recurring group survives.
    const out = recurringInstructions([
      'Keep it short',
      'keep it   short',
      '  KEEP IT short  ',
      'add a friendly opener',
    ]);
    expect(out).toEqual(['Keep it short']); // first-seen original spelling, whitespace-collapsed
  });

  it('honors a custom minCount threshold', () => {
    const insts = ['a', 'a', 'b', 'b', 'b'];
    expect(recurringInstructions(insts, { minCount: 3 })).toEqual(['b']); // only b reaches 3
    expect(recurringInstructions(insts, { minCount: 2 })).toEqual(['b', 'a']); // b(3) before a(2)
  });

  it('orders most-frequent first, breaking ties by first appearance (deterministic)', () => {
    const insts = ['second', 'first', 'first', 'second', 'first', 'second'];
    // both reach count 3 → tie broken by first appearance: "second" appeared at index 0.
    expect(recurringInstructions(insts)).toEqual(['second', 'first']);
  });

  it('ignores blank / whitespace-only instructions entirely', () => {
    expect(recurringInstructions(['', '   ', '\n\t'])).toEqual([]);
    expect(recurringInstructions(['real', '', 'real', '   '])).toEqual(['real']);
  });

  it('is a pure function: the same input yields the same output every call', () => {
    const insts = ['x', 'x', 'y', 'y', 'y'];
    expect(recurringInstructions(insts)).toEqual(recurringInstructions(insts));
  });
});

describe('draftVsSentDiff — what the user changed before sending (PROJECT.md §6b)', () => {
  it('an UNEDITED send is not changed: empty added/removed, every line unchanged', () => {
    const body = 'Hi Petr\nThe numbers are attached.\nBest, Jan';
    const diff = draftVsSentDiff(body, body);
    expect(diff.changed).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(3);
  });

  it('captures the meaningful delta: kept lines unchanged, edited line shows as remove + add', () => {
    const diff = draftVsSentDiff('Hi\nThanks\nBest, Jan', 'Hi\nThanks a lot\nBest');
    expect(diff.changed).toBe(true);
    expect(diff.unchanged).toBe(1); // "Hi" survived
    expect(diff.added).toContain('Thanks a lot'); // sent-only
    expect(diff.added).toContain('Best'); // sent-only
    expect(diff.removed).toContain('Thanks'); // draft-only
    expect(diff.removed).toContain('Best, Jan'); // draft-only
  });

  it('a pure deletion (the user cut Claude’s closing) shows only removals', () => {
    const diff = draftVsSentDiff('Hi\nThanks\nKind regards,\nJan', 'Hi\nThanks');
    expect(diff.changed).toBe(true);
    expect(diff.removed).toEqual(['Kind regards,', 'Jan']);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });

  it('a pure addition (the user added a line) shows only additions', () => {
    const diff = draftVsSentDiff('Hi\nThanks', 'Hi\nThanks\nPS: lunch Friday?');
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(['PS: lunch Friday?']);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });

  it('is DETERMINISTIC: the same two bodies always yield byte-identical segments', () => {
    const a = draftVsSentDiff('one\ntwo\nthree', 'one\nTWO\nthree');
    const b = draftVsSentDiff('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(a).toEqual(b);
  });

  it('renderDiffSummary marks +/-/space lines for the learn prompt, in segment order', () => {
    const diff: DiffSummary = draftVsSentDiff('keep\ncut', 'keep\nadd');
    const rendered = renderDiffSummary(diff);
    expect(rendered).toContain('  keep'); // unchanged → leading space
    expect(rendered).toContain('- cut'); // draft-only → minus
    expect(rendered).toContain('+ add'); // sent-only → plus
    // unchanged line precedes the change in the rendered block (segment order preserved).
    expect(rendered.indexOf('  keep')).toBeLessThan(rendered.indexOf('- cut'));
  });
});
