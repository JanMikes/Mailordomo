/**
 * INTENT-DERIVED suite for the promise-EXTRACTION consumer (PROJECT.md §7/§4) via the FAKE runner —
 * no live call. Complements `extract-promises.test.ts` (the implementer's smoke) by hardening: the
 * full pipeline REJECTS a malformed candidate (defense in depth at the `extractPromises` boundary,
 * not just `parseExtraction`), the candidate-schema boundaries, and — the load-bearing wiring — that
 * the message-received instant is threaded into the deterministic reconciler as the Europe/Prague
 * deadline anchor (proven on a WINTER message, so the CET offset is exercised too).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClaudeRunner } from './fake-runner';
import { extractPromises, renderExtractionPrompt } from './extract-promises';
import type { ExtractionMessageInput } from './extract-promises';
import { PromiseExtractionSchema } from './promise-extraction-schema';
import type { PromiseCandidate } from './promise-extraction-schema';

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

function candidate(over: Partial<PromiseCandidate> = {}): PromiseCandidate {
  return {
    direction_hint: 'awaiting-them',
    text: 'Petr sends the signed contract',
    due_raw: 'tomorrow',
    due_at: null,
    who: 'Petr',
    whom: 'me',
    fulfillment_signal: 'none',
    confidence: 'high',
    ...over,
  };
}

const reconcile = { threadId: 't1' as const, nowIso: '2026-01-10T12:00:00Z', newId: () => 'p1' };

describe('renderExtractionPrompt — the Europe/Prague deadline anchor block', () => {
  const message: ExtractionMessageInput = {
    subject: 'Contract',
    sender: 'petr@fontai.cz',
    body: 'I will send the signed contract tomorrow.',
    receivedIso: '2026-01-05T08:00:00+01:00',
  };

  it('states the received instant and defaults the timezone to Europe/Prague', () => {
    const prompt = renderExtractionPrompt(message);
    expect(prompt).toContain('Message received: 2026-01-05T08:00:00+01:00');
    expect(prompt).toContain('Mailbox timezone: Europe/Prague');
  });

  it('honors an explicit mailbox timezone override', () => {
    const prompt = renderExtractionPrompt({ ...message, timezone: 'America/New_York' });
    expect(prompt).toContain('Mailbox timezone: America/New_York');
    expect(prompt).not.toContain('Europe/Prague');
  });
});

describe('extractPromises — candidates flow through the reconciler with the received-date anchor', () => {
  const message: ExtractionMessageInput = {
    subject: 'Contract',
    sender: 'petr@fontai.cz',
    body: 'I will send the signed contract tomorrow.',
    receivedIso: '2026-01-05T08:00:00+01:00', // Mon 5 Jan 2026, Prague CET (winter)
  };

  it('resolves "tomorrow" against the WINTER message date (CET ⇒ 22:59:59Z) and marks it overdue', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        'promise-extraction': {
          structuredOutput: { promises: [candidate()] },
          model: 'claude-haiku-4-5',
        },
      },
    });

    const out = await extractPromises(runner, message, reconcile);

    expect(out.promises).toHaveLength(1);
    const record = out.promises[0];
    expect(record?.direction).toBe('awaiting-them');
    // "tomorrow" from Mon 5 Jan = end of Tue 6 Jan, CET (+01:00) → 22:59:59Z (the anchor + tz wiring).
    expect(record?.due_at).toBe('2026-01-06T22:59:59.000Z');
    expect(record?.due_raw).toBe('tomorrow'); // raw phrase carried verbatim
    // Due 6 Jan is before now 10 Jan → the reconciler marks the lapsed inbound promise overdue.
    expect(record?.status).toBe('overdue');
    // The validated candidate is surfaced alongside the record.
    expect(out.candidates[0]?.who).toBe('Petr');
  });

  it('REJECTS a malformed structured_output at the extractPromises boundary (defense in depth)', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        'promise-extraction': {
          // Missing required `who`/`whom` — must not silently produce a record.
          structuredOutput: { promises: [{ direction_hint: 'awaiting-them', text: 'x' }] },
        },
      },
    });
    await expect(extractPromises(runner, message, reconcile)).rejects.toThrow();
  });
});

describe('PromiseExtractionSchema — candidate field boundaries', () => {
  const tooLong = 'x'.repeat(201);

  it.each([
    ['unknown direction', { direction_hint: 'archive' }],
    ['empty text', { text: '' }],
    ['due_raw over 200 chars', { due_raw: tooLong }],
    ['due_at without a timezone offset', { due_at: '2026-06-12T09:30:00' }],
    ['due_at that is a bare date', { due_at: '2026-06-12' }],
    ['unknown confidence', { confidence: 'certain' }],
  ])('rejects a candidate with %s', (_label, bad) => {
    expect(() =>
      PromiseExtractionSchema.parse({ promises: [{ ...candidate(), ...bad }] }),
    ).toThrow();
  });

  it('accepts a well-formed candidate (including a null due_raw/due_at)', () => {
    const parsed = PromiseExtractionSchema.parse({
      promises: [candidate({ due_raw: null, due_at: null })],
    });
    expect(parsed.promises).toHaveLength(1);
    expect(parsed.promises[0]?.due_at).toBeNull();
  });
});
