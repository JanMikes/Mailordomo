/**
 * SMOKE — the promise-extraction consumer (PROJECT.md §7/§4) via the FAKE runner. No live call. Thin
 * coverage; the SEPARATE test-author writes the load-bearing suite (recorded-fixture golden cases +
 * deeper reconciliation). Here we pin: the spec is a Haiku, schema-constrained, anchor-carrying job;
 * the fake's structured candidates flow through the reconciler into PromiseRecords; and malformed
 * structured_output / error envelopes are rejected (defense in depth).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClaudeRunner } from './fake-runner';
import {
  buildExtractionSpec,
  extractPromises,
  parseExtraction,
  renderExtractionPrompt,
} from './extract-promises';
import type { ExtractionMessageInput } from './extract-promises';
import {
  PROMISE_EXTRACTION_JSON_SCHEMA,
  PromiseExtractionSchema,
} from './promise-extraction-schema';
import type { PromiseCandidate } from './promise-extraction-schema';
import type { JobResult } from './types';

const REPO_PROMPTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../prompts',
);

let prevPromptsDir: string | undefined;
beforeAll(() => {
  prevPromptsDir = process.env.CLAUDE_PROMPTS_DIR;
  process.env.CLAUDE_PROMPTS_DIR = REPO_PROMPTS;
});
afterAll(() => {
  if (prevPromptsDir === undefined) delete process.env.CLAUDE_PROMPTS_DIR;
  else process.env.CLAUDE_PROMPTS_DIR = prevPromptsDir;
});

const MESSAGE: ExtractionMessageInput = {
  subject: 'API spec',
  sender: 'petr@fontai.cz',
  body: "Could you send the v2 API spec by Friday? I'll get you the contract tomorrow.",
  receivedIso: '2026-06-01T08:00:00+02:00', // Mon Jun 1, Prague
};

function candidate(over: Partial<PromiseCandidate> = {}): PromiseCandidate {
  return {
    direction_hint: 'they-asked',
    text: 'Send the v2 API spec',
    due_raw: 'by Friday',
    due_at: null,
    who: 'me',
    whom: 'Petr',
    fulfillment_signal: 'none',
    confidence: 'high',
    ...over,
  };
}

describe('buildExtractionSpec — the PURE extraction job spec (§4/§7)', () => {
  it('is a Haiku, schema-constrained, Read-only job with an anchor in the prompt', () => {
    const spec = buildExtractionSpec(MESSAGE);
    expect(spec.taskKind).toBe('promise-extraction');
    expect(spec.jsonSchema).toBe(PROMISE_EXTRACTION_JSON_SCHEMA);
    expect(spec.allowedTools).toEqual(['Read']);
    expect(spec.systemPromptFile).toContain('extract-promises.md');
    expect(spec.prompt).toContain('2026-06-01T08:00:00+02:00');
    expect(spec.prompt).toContain('Europe/Prague');
  });
});

describe('renderExtractionPrompt — includes the deadline anchor block', () => {
  it('states the received instant and timezone', () => {
    const prompt = renderExtractionPrompt(MESSAGE);
    expect(prompt).toContain('Message received: 2026-06-01T08:00:00+02:00');
    expect(prompt).toContain('Mailbox timezone: Europe/Prague');
    expect(prompt).toContain(MESSAGE.body);
  });
});

describe('extractPromises — fake runner candidates → reconciled PromiseRecords', () => {
  it('routes via a Haiku spec and reconciles both directions with deadlines anchored', async () => {
    let n = 0;
    const runner = new FakeClaudeRunner({
      byKind: {
        'promise-extraction': {
          structuredOutput: {
            promises: [
              candidate({
                direction_hint: 'they-asked',
                who: 'me',
                whom: 'Petr',
                due_raw: 'by Friday',
              }),
              candidate({
                text: 'Petr sends the contract',
                direction_hint: 'awaiting-them',
                who: 'Petr',
                whom: 'me',
                due_raw: 'tomorrow',
              }),
            ],
          },
          costUsd: 0.004,
          model: 'claude-haiku-4-5',
        },
      },
    });

    const out = await extractPromises(runner, MESSAGE, {
      threadId: 't1',
      nowIso: '2026-06-05T12:00:00Z',
      newId: () => `p${(n += 1)}`,
    });

    expect(out.candidates).toHaveLength(2);
    expect(out.promises).toHaveLength(2);
    expect(out.costUsd).toBeCloseTo(0.004, 6);
    // they-asked → I owe; Friday Jun 5 end-of-day in CEST is in the future relative to noon Jun 5 → open.
    expect(out.promises[0]?.direction).toBe('they-asked');
    expect(out.promises[0]?.due_at).toBe('2026-06-05T21:59:59.000Z');
    // awaiting-them; "tomorrow" = Jun 2 end-of-day, before now Jun 5 → overdue.
    expect(out.promises[1]?.direction).toBe('awaiting-them');
    expect(out.promises[1]?.status).toBe('overdue');
    // Routing: the built argv carries --model haiku.
    const argv = runner.argv[0] ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
  });

  it('an empty promises array reconciles to no records', async () => {
    const runner = new FakeClaudeRunner({
      byKind: { 'promise-extraction': { structuredOutput: { promises: [] } } },
    });
    const out = await extractPromises(runner, MESSAGE, {
      threadId: 't1',
      nowIso: '2026-06-05T12:00:00Z',
      newId: () => 'p',
    });
    expect(out.promises).toHaveLength(0);
  });
});

describe('parseExtraction / PromiseExtractionSchema — defense in depth', () => {
  function jobResult(over: Partial<JobResult>): JobResult {
    return {
      text: '',
      model: 'claude-haiku-4-5',
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      isError: false,
      sessionId: 's',
      numTurns: 1,
      durationMs: 0,
      ...over,
    };
  }

  it('parses good structured_output into candidates', () => {
    const out = parseExtraction(jobResult({ structuredOutput: { promises: [candidate()] } }));
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('Send the v2 API spec');
  });

  it('throws on an error envelope', () => {
    expect(() =>
      parseExtraction(jobResult({ isError: true, apiErrorStatus: 529, text: 'Overloaded' })),
    ).toThrow(/promise-extraction job failed/);
  });

  it('rejects malformed structured_output (bad direction / missing field)', () => {
    expect(() =>
      PromiseExtractionSchema.parse({ promises: [{ ...candidate(), direction_hint: 'archive' }] }),
    ).toThrow();
    expect(() => PromiseExtractionSchema.parse({ promises: [{ text: 'x' }] })).toThrow();
    expect(() => PromiseExtractionSchema.parse({ not: 'an extraction' })).toThrow();
  });
});
