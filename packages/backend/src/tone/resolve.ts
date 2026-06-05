/**
 * PURE tone-memory layer resolver (PROJECT.md §3/§6: tone memory is layered project → mailbox →
 * contact, "contact overrides"). Given the applicable tone files for a drafting context — the
 * `project`-scope file, the `mailbox`-scope file, the `contact`-scope file (any may be absent) —
 * compose them into ONE resolved tone-memory document, in layer order, with **contact last so it
 * overrides** (the most-specific guidance is read last, which is what an LLM weights highest).
 *
 * This is the document a draft job receives via `--append-system-prompt-file` (the layered tone file
 * appended onto the per-task system prompt). It is deliberately a PURE function of its inputs (no IO,
 * no clock) so it is fully unit-testable; the IO (reading the layer files off disk) lives in
 * `tone/store.ts`, and the composed string is written to a temp/resolved file by the caller.
 *
 * Override semantics: we do NOT field-merge or de-conflict the layers (that would be the forbidden
 * two-store reconciliation of Golden rule #2). We simply ORDER them — every layer's full text is
 * present, with the more specific scope physically later in the document under a clear delimiter, so
 * the model reads contact guidance after (and thus weighted over) mailbox after project.
 */
import type { ToneScope } from '@mailordomo/shared';
import { TONE_SCOPES } from '@mailordomo/shared';

/** One tone-memory layer: its scope and its raw markdown content. */
export interface ToneLayer {
  readonly scope: ToneScope;
  readonly content: string;
}

/** Rank a scope by the canonical layer order (`project` < `mailbox` < `contact`). */
function scopeRank(scope: ToneScope): number {
  return TONE_SCOPES.indexOf(scope);
}

/** Human-facing section heading for a scope (used as the in-document delimiter). */
function scopeHeading(scope: ToneScope): string {
  return `# Tone memory — ${scope} scope`;
}

/**
 * Order the supplied layers into the canonical project → mailbox → contact sequence and drop any
 * with blank/whitespace-only content (an absent or empty layer contributes nothing). Stable within a
 * scope. PURE — returns a new array, never mutates the input. Exposed (alongside the composed string)
 * so callers/tests can assert ordering directly without parsing the rendered document.
 */
export function orderToneLayers(layers: readonly ToneLayer[]): ToneLayer[] {
  return (
    layers
      .filter((layer) => layer.content.trim() !== '')
      .map((layer, index) => ({ layer, index }))
      // Sort by scope rank; preserve input order for equal scopes (stable tiebreak on original index).
      .sort((a, b) => scopeRank(a.layer.scope) - scopeRank(b.layer.scope) || a.index - b.index)
      .map(({ layer }) => layer)
  );
}

/**
 * Compose the applicable tone layers into ONE resolved tone-memory document, project → mailbox →
 * contact (contact last so it overrides). Each present layer is emitted under a clear scope heading;
 * missing/empty layers are skipped; all-absent yields the empty string (no tone guidance at all).
 *
 * @returns the composed markdown, ready to hand to a draft job as the appended tone file.
 */
export function resolveToneMemory(layers: readonly ToneLayer[]): string {
  const ordered = orderToneLayers(layers);
  if (ordered.length === 0) {
    return '';
  }
  return ordered
    .map((layer) => `${scopeHeading(layer.scope)}\n\n${layer.content.trim()}`)
    .join('\n\n');
}
