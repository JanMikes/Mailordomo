/**
 * LOAD-BEARING — structured_output handling (PROJECT.md §4: `--json-schema` → constrained
 * `structured_output`; free-text jobs return `result`/`text` only).
 *
 * Derived from §4 intent: a SCHEMA'D job (triage) exposes its answer as the `structuredOutput`
 * OBJECT for deterministic consumption (no fragile free-text parsing); a NO-SCHEMA job (summarize)
 * exposes `text` only and has no `structuredOutput`. We assert this at the runner seam (the fake
 * runner returns a JobResult) and that the spec's `jsonSchema` is what flips the argv.
 */
import { describe, expect, it } from 'vitest';
import { FakeClaudeRunner } from './fake-runner';
import { TRIAGE_JSON_SCHEMA, TriageDecisionSchema } from './triage-schema';
import type { JobSpec } from './types';

describe('a SCHEMA-constrained job exposes structuredOutput as an object', () => {
  it('the runner returns structuredOutput; the consumer reads it WITHOUT parsing free text', async () => {
    const decision = {
      disposition: 'needs-reply',
      needs_reply: true,
      importance: 'high',
      confidence: 'high',
      reason: 'prod down',
    };
    const runner = new FakeClaudeRunner({ byKind: { triage: { structuredOutput: decision } } });
    const spec: JobSpec = { taskKind: 'triage', prompt: 'p', jsonSchema: TRIAGE_JSON_SCHEMA };
    const result = await runner.run(spec);

    expect(typeof result.structuredOutput).toBe('object');
    expect(result.structuredOutput).toEqual(decision);
    // Validates as a real decision — the structured path, not free text.
    expect(TriageDecisionSchema.parse(result.structuredOutput).disposition).toBe('needs-reply');
    // The spec that drove it carried the schema, which is what populates structured_output upstream.
    expect(runner.argv[0]).toContain('--json-schema');
  });
});

describe('a NO-SCHEMA job has text only and no structuredOutput', () => {
  it('the runner returns text; structuredOutput is undefined; argv has no --json-schema', async () => {
    const runner = new FakeClaudeRunner({ byKind: { summarize: { text: 'a prose summary' } } });
    const result = await runner.run({ taskKind: 'summarize', prompt: 'p' });

    expect(result.text).toBe('a prose summary');
    expect(result.structuredOutput).toBeUndefined();
    expect(runner.argv[0]).not.toContain('--json-schema');
  });
});

describe('the fake runner records each spec/argv so a test can assert what was asked', () => {
  it('captures the JobSpec and the argv buildClaudeArgs WOULD produce per call', async () => {
    const runner = new FakeClaudeRunner({ fallback: { text: 'ok' } });
    await runner.run({ taskKind: 'triage', prompt: 'one', jsonSchema: { type: 'object' } });
    await runner.run({ taskKind: 'summarize', prompt: 'two' });

    expect(runner.calls.map((c) => c.taskKind)).toEqual(['triage', 'summarize']);
    expect(runner.argv).toHaveLength(2);
    expect(runner.argv[0]?.[runner.argv[0].indexOf('--model') + 1]).toBe('haiku');
    expect(runner.argv[1]?.[runner.argv[1].indexOf('--model') + 1]).toBe('sonnet');
  });
});
