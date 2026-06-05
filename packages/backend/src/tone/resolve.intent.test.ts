/**
 * INTENT-DERIVED suite for the layered tone-memory resolver (PROJECT.md §3/§6:
 * "Tone memory is layered: project → mailbox → contact (contact overrides)"). Written from the SPEC's
 * stated layering, NOT from the implementation — additive to the implementer's `tone.smoke.test.ts`.
 *
 * The load-bearing invariant pinned here is the OVERRIDE SEMANTICS: the more-specific scope must be
 * read LAST so it wins (contact overrides mailbox overrides project). We assert ORDER (the mechanism),
 * input-order independence, the full present/absent subset matrix, whole-text survival (every present
 * layer's full text is kept — never a field-merge, Golden rule #2), and determinism.
 *
 * MUTATION CHECK (pins "contact-override order"): if `resolveToneMemory`/`orderToneLayers` emitted
 * contact FIRST (or sorted by any other key), the `contact text after project text` and the
 * `SPEC_LAYER_ORDER` matrix assertions below would fail. Verified by reasoning: reverse the sort in
 * `resolve.ts` and `composes the layers so contact is read LAST (it overrides)` flips and fails.
 */
import { describe, expect, it } from 'vitest';
import type { ToneScope } from '@mailordomo/shared';
import { orderToneLayers, resolveToneMemory } from './resolve';
import type { ToneLayer } from './resolve';

/**
 * The canonical layering taken DIRECTLY from PROJECT.md §6 prose ("project → mailbox → contact"),
 * declared independently here so a mis-ordered `TONE_SCOPES` in the impl would be caught rather than
 * mirrored. The least-specific layer is first; the most-specific (contact) is last and overrides.
 */
const SPEC_LAYER_ORDER: readonly ToneScope[] = ['project', 'mailbox', 'contact'];

/** Every non-empty subset of the three scopes (the present/absent matrix), plus the empty set. */
const ALL_SUBSETS: readonly ToneScope[][] = [
  [],
  ['project'],
  ['mailbox'],
  ['contact'],
  ['project', 'mailbox'],
  ['project', 'contact'],
  ['mailbox', 'contact'],
  ['project', 'mailbox', 'contact'],
];

/** A layer whose content is a unique, greppable marker so we can locate it in the composed doc. */
function layer(scope: ToneScope): ToneLayer {
  return { scope, content: `<<${scope.toUpperCase()}-VOICE>>` };
}

describe('orderToneLayers — canonical project → mailbox → contact, input-order independent', () => {
  it('orders every subset into the SPEC layer order regardless of how the inputs are arranged', () => {
    for (const subset of ALL_SUBSETS) {
      const present = new Set(subset);
      const expected = SPEC_LAYER_ORDER.filter((s) => present.has(s));
      // Feed the layers in a deliberately WRONG (reversed) order; the resolver must re-canonicalize.
      const reversed = [...subset].reverse().map(layer);
      expect(orderToneLayers(reversed).map((l) => l.scope)).toEqual(expected);
    }
  });

  it('is a pure permutation-invariant function: all input orderings yield the identical result', () => {
    const base = SPEC_LAYER_ORDER.map(layer);
    const permutations: ToneLayer[][] = [
      [base[0]!, base[1]!, base[2]!],
      [base[2]!, base[1]!, base[0]!],
      [base[1]!, base[2]!, base[0]!],
      [base[2]!, base[0]!, base[1]!],
    ];
    const results = permutations.map((p) => orderToneLayers(p).map((l) => l.scope));
    for (const r of results) {
      expect(r).toEqual(['project', 'mailbox', 'contact']);
    }
  });

  it('drops absent/empty layers (whitespace-only contributes nothing)', () => {
    const ordered = orderToneLayers([
      { scope: 'project', content: 'real project' },
      { scope: 'mailbox', content: '   \n\t  ' }, // present-but-blank ⇒ absent
      { scope: 'contact', content: '' }, // empty ⇒ absent
    ]);
    expect(ordered.map((l) => l.scope)).toEqual(['project']);
  });
});

describe('resolveToneMemory — contact is read LAST so it OVERRIDES (PROJECT.md §6)', () => {
  it('positions project before mailbox before contact in the composed document', () => {
    const doc = resolveToneMemory(SPEC_LAYER_ORDER.map(layer));
    const pProject = doc.indexOf('<<PROJECT-VOICE>>');
    const pMailbox = doc.indexOf('<<MAILBOX-VOICE>>');
    const pContact = doc.indexOf('<<CONTACT-VOICE>>');
    expect(pProject).toBeGreaterThanOrEqual(0);
    expect(pProject).toBeLessThan(pMailbox);
    expect(pMailbox).toBeLessThan(pContact);
  });

  it('on CONFLICTING guidance, the contact directive is the LAST one (the override the model weights)', () => {
    // project says formal; contact says casual — the override mechanism is physical ordering: the
    // contact directive must come AFTER the project directive (read last ⇒ wins).
    const doc = resolveToneMemory([
      { scope: 'project', content: 'Always write in a FORMAL register.' },
      { scope: 'contact', content: 'With this contact, be CASUAL and brief.' },
    ]);
    expect(doc.indexOf('FORMAL')).toBeLessThan(doc.indexOf('CASUAL'));
    // contact guidance is the final non-empty content in the document (nothing more specific follows).
    expect(doc.trimEnd().endsWith('be CASUAL and brief.')).toBe(true);
  });

  it('keeps EVERY present layer in full (whole-text survival — not a field-merge, Golden rule #2)', () => {
    const doc = resolveToneMemory(SPEC_LAYER_ORDER.map(layer));
    // All three full markers survive — no layer is dropped, truncated, or spliced together.
    expect(doc).toContain('<<PROJECT-VOICE>>');
    expect(doc).toContain('<<MAILBOX-VOICE>>');
    expect(doc).toContain('<<CONTACT-VOICE>>');
  });

  it('only the present layers appear — an absent middle layer leaves project→contact adjacent', () => {
    const doc = resolveToneMemory([layer('project'), layer('contact')]);
    expect(doc).toContain('<<PROJECT-VOICE>>');
    expect(doc).toContain('<<CONTACT-VOICE>>');
    expect(doc).not.toContain('<<MAILBOX-VOICE>>');
    expect(doc.indexOf('<<PROJECT-VOICE>>')).toBeLessThan(doc.indexOf('<<CONTACT-VOICE>>'));
  });

  it('all-absent (and empty input) compose to the empty string — no tone guidance at all', () => {
    expect(resolveToneMemory([])).toBe('');
    expect(resolveToneMemory([{ scope: 'contact', content: '   ' }])).toBe('');
    expect(
      resolveToneMemory([
        { scope: 'project', content: '' },
        { scope: 'mailbox', content: '\n' },
        { scope: 'contact', content: '\t' },
      ]),
    ).toBe('');
  });

  it('is deterministic: composing the same layers twice yields byte-identical output', () => {
    const layers = SPEC_LAYER_ORDER.map(layer);
    expect(resolveToneMemory(layers)).toBe(resolveToneMemory(layers));
  });
});
