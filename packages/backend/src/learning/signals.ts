/**
 * PURE learning SIGNALS (PROJECT.md §6 "Continuous learning is silent + logged + revertable: Claude
 * updates tone-memory markdown from (a) recurring draft instructions and (b) the diff between its
 * draft and what the user actually sent"). These are the two deterministic signal extractors that
 * turn raw observations into something the Sonnet `learn` job can summarize into a tone lesson.
 *
 * Both are PURE (no IO, no clock, no randomness) so they are fully unit-testable and produce identical
 * output for identical input — the LLM step is the only non-determinism, and it is mocked in tests.
 */

/* -------------------------------------------------------------------------- */
/* (a) Recurring draft instructions                                            */
/* -------------------------------------------------------------------------- */

export interface RecurringInstructionsOptions {
  /** Minimum occurrences (after normalization) for an instruction to count as recurring. Default 2. */
  readonly minCount?: number;
}

/** Normalize an instruction for COUNTING: trim, collapse internal whitespace, lowercase. */
function normalizeInstruction(instruction: string): string {
  return instruction.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Detect "context for Claude" draft instructions that RECUR — the same guidance the user keeps typing
 * into the draft instruction textarea (e.g. repeatedly "keep it short", "no exclamation marks"). Such
 * a repeat is a strong, durable signal worth promoting into tone memory.
 *
 * Counting is by NORMALIZED form (whitespace-collapsed, case-insensitive) so trivial variations group
 * together; the returned value for each recurring group is its FIRST-SEEN original spelling (trimmed +
 * whitespace-collapsed) so the lesson reads naturally. Ordered by descending occurrence count, ties
 * broken by first appearance — deterministic. Blank instructions are ignored.
 *
 * @returns the recurring instructions (count ≥ `minCount`), most-frequent first.
 */
export function recurringInstructions(
  instructions: readonly string[],
  opts: RecurringInstructionsOptions = {},
): string[] {
  const minCount = opts.minCount ?? 2;

  interface Group {
    count: number;
    firstIndex: number;
    original: string;
  }
  const groups = new Map<string, Group>();

  instructions.forEach((raw, index) => {
    const key = normalizeInstruction(raw);
    if (key === '') return; // ignore blank/whitespace-only instructions
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { count: 1, firstIndex: index, original: raw.trim().replace(/\s+/g, ' ') });
    } else {
      existing.count += 1;
    }
  });

  return [...groups.values()]
    .filter((group) => group.count >= minCount)
    .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)
    .map((group) => group.original);
}

/* -------------------------------------------------------------------------- */
/* (b) Draft-vs-sent diff                                                      */
/* -------------------------------------------------------------------------- */

/** One line-level operation in a draft→sent diff. */
export type DiffOp = 'equal' | 'add' | 'remove';

/** A single diffed line: what happened to it (`equal` kept, `add` in sent only, `remove` draft only). */
export interface DiffSegment {
  readonly op: DiffOp;
  readonly text: string;
}

/**
 * A deterministic, structured draft→sent diff: the LEARNING SIGNAL of how the user edited Claude's
 * draft before sending. `segments` is the ordered line-level diff (LCS-based); `added`/`removed` are
 * convenience projections; `changed` is true iff the user altered anything.
 */
export interface DiffSummary {
  readonly segments: DiffSegment[];
  /** Lines present only in what the user SENT (Claude under-said / the user added). */
  readonly added: string[];
  /** Lines present only in Claude's DRAFT (the user cut them). */
  readonly removed: string[];
  /** Count of unchanged lines. */
  readonly unchanged: number;
  /** Whether the sent message differs from the draft at all. */
  readonly changed: boolean;
}

/**
 * PURE line-level LCS diff between Claude's draft and what the user actually sent. Deterministic: the
 * same two bodies always yield the same segments. Used as the structured input the `learn` job
 * summarizes into a durable tone lesson ("the user consistently shortens my closings", etc.).
 *
 * Bodies are read/diffed LOCALLY (this runs on the user's machine) and NEVER leave it — only the
 * resulting one-line `summary` from the LLM step crosses to the server (Golden rule #3).
 */
export function draftVsSentDiff(draftBody: string, sentBody: string): DiffSummary {
  const a = draftBody.split('\n');
  const b = sentBody.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i:] and b[j:]. Sized (n+1)×(m+1), zero-filled, so the boundary
  // row/column are 0. `at(i,j)` reads it safely (the `?? 0` only ever hits the implicit zero border —
  // it is here to satisfy `noUncheckedIndexedAccess`, never reached for an in-bounds cell).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => dp[i]?.[j] ?? 0;
  const lineA = (i: number): string => a[i] ?? '';
  const lineB = (j: number): string => b[j] ?? '';

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i];
    if (row === undefined) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = lineA(i) === lineB(j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  // Walk the table forward, emitting equal/remove/add in order.
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lineA(i) === lineB(j)) {
      segments.push({ op: 'equal', text: lineA(i) });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      segments.push({ op: 'remove', text: lineA(i) });
      i += 1;
    } else {
      segments.push({ op: 'add', text: lineB(j) });
      j += 1;
    }
  }
  for (; i < n; i += 1) segments.push({ op: 'remove', text: lineA(i) });
  for (; j < m; j += 1) segments.push({ op: 'add', text: lineB(j) });

  const added = segments.filter((s) => s.op === 'add').map((s) => s.text);
  const removed = segments.filter((s) => s.op === 'remove').map((s) => s.text);
  const unchanged = segments.filter((s) => s.op === 'equal').length;

  return { segments, added, removed, unchanged, changed: added.length > 0 || removed.length > 0 };
}

/** Render a {@link DiffSummary} into a compact unified-diff-style block for the `learn` prompt. */
export function renderDiffSummary(diff: DiffSummary): string {
  return diff.segments
    .map((segment) => {
      const marker = segment.op === 'add' ? '+' : segment.op === 'remove' ? '-' : ' ';
      return `${marker} ${segment.text}`;
    })
    .join('\n');
}
