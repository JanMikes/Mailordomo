/**
 * LOAD-BEARING — Recorded-fixture golden cases (PLAN.md §4.8 + §5 "fake runner + recorded fixtures").
 *
 * §4.8: recorded `claude` outputs are DELIBERATELY-REGENERATED artifacts under `__fixtures__/llm/`,
 * each carrying a `// GENERATED — do not hand-edit; run \`npm run refresh-fixtures\`` header so a
 * hand-edit is visible in review; tests REPLAY them (never live). This suite:
 *   - replays each fixture through `parseClaudeJson` (string path) → the expected JobResult, the
 *     golden case for triage (structured) and summarize (free-text);
 *   - asserts both fixture FILES carry the GENERATED header (so a silent hand-edit is caught).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRIAGE_FIXTURE } from './__fixtures__/llm/triage.fixture';
import { SUMMARIZE_FIXTURE } from './__fixtures__/llm/summarize.fixture';
import { parseClaudeJson } from './parse-json';
import { TriageDecisionSchema } from './triage-schema';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '__fixtures__', 'llm');
const GENERATED_HEADER = '// GENERATED — do not hand-edit; run `npm run refresh-fixtures`';

describe('golden replay — TRIAGE_FIXTURE → JobResult (structured)', () => {
  it('replays through the string parser into the expected structured JobResult', () => {
    const result = parseClaudeJson(JSON.stringify(TRIAGE_FIXTURE), 'haiku');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.costUsd).toBeCloseTo(0.04118875, 10);
    expect(result.isError).toBe(false);
    expect(result.text).toBe('');
    // The structured_output validates as a real TriageDecision (the golden triage case).
    const decision = TriageDecisionSchema.parse(result.structuredOutput);
    expect(decision).toEqual({
      disposition: 'needs-reply',
      needs_reply: true,
      importance: 'high',
      confidence: 'high',
      reason: 'A production outage affecting customers requires an acknowledgement and action.',
    });
  });
});

describe('golden replay — SUMMARIZE_FIXTURE → JobResult (free-text)', () => {
  it('replays into a prose JobResult with NO structured_output', () => {
    const result = parseClaudeJson(JSON.stringify(SUMMARIZE_FIXTURE), 'sonnet');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.costUsd).toBeCloseTo(0.0193245, 10);
    expect(result.structuredOutput).toBeUndefined();
    expect(result.text).toContain('API spec by Thursday');
    expect(result.text).toContain('Friday 10:00 demo');
  });
});

describe('fixtures are marked as deliberately-regenerated artifacts (§4.8)', () => {
  for (const file of ['triage.fixture.ts', 'summarize.fixture.ts']) {
    it(`${file} carries the GENERATED header (a hand-edit is visible in review)`, () => {
      const src = readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      expect(src.startsWith(GENERATED_HEADER)).toBe(true);
    });
  }
});
