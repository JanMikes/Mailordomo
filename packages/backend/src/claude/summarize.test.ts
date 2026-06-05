/**
 * LOAD-BEARING — Thread summarization consumer (PROJECT.md §4/§9) via the FAKE runner. No live call.
 *
 * §4 intent: summaries are SONNET, free-text (no `--json-schema`) — returned in the envelope's
 * `result`/`text`. Derived assertions:
 *   - `summarizeThread` returns the fake's text;
 *   - an EMPTY or whitespace-only summary is rejected (a summary that says nothing is a failure);
 *   - an ERROR envelope is rejected;
 *   - the built spec routes to Sonnet and renders the thread oldest→newest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClaudeRunner } from './fake-runner';
import { buildSummarizeSpec, parseSummary, renderThreadPrompt, summarizeThread } from './summarize';
import type { ThreadMessageInput } from './summarize';
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

const THREAD: ThreadMessageInput[] = [
  { sender: 'petr@fontai.cz', date: '2026-06-01', body: 'Can you send the v2 API spec?' },
  { sender: 'me@mailordomo', date: '2026-06-02', body: 'Yes, by Thursday EOD.' },
];

function jobResult(overrides: Partial<JobResult>): JobResult {
  return {
    text: '',
    model: 'claude-sonnet-4-6',
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
    ...overrides,
  };
}

describe('summarizeThread — returns the fake runner text + cost/model (fake runner)', () => {
  it('returns the prose summary from `text` + the call cost/model', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        summarize: {
          text: 'Petr asked for the spec; you promised Thursday.',
          costUsd: 0.02,
          model: 'claude-sonnet-4-6',
        },
      },
    });
    const out = await summarizeThread(runner, THREAD);
    expect(out.summary).toBe('Petr asked for the spec; you promised Thursday.');
    expect(out.costUsd).toBeCloseTo(0.02, 6);
    expect(out.model).toBe('claude-sonnet-4-6');
  });

  it('surfaces the fake runner default model alias when the fake does not override it', async () => {
    // The fake runner's baseResult defaults `model` to the routed ALIAS (`sonnet`) unless overridden.
    const runner = new FakeClaudeRunner({ byKind: { summarize: { text: 'ok' } } });
    const out = await summarizeThread(runner, THREAD);
    expect(out.model).toBe('sonnet');
  });

  it('trims surrounding whitespace from the summary', async () => {
    const runner = new FakeClaudeRunner({ byKind: { summarize: { text: '  trimmed.\n' } } });
    const out = await summarizeThread(runner, THREAD);
    expect(out.summary).toBe('trimmed.');
  });

  it('dispatches a summarize spec (Sonnet) — the fake records a Sonnet-routed call', async () => {
    const runner = new FakeClaudeRunner({ byKind: { summarize: { text: 'ok' } } });
    await summarizeThread(runner, THREAD);
    expect(runner.calls[0]?.taskKind).toBe('summarize');
    const argv = runner.argv[0] ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    // No schema for a free-text summary.
    expect(argv).not.toContain('--json-schema');
  });
});

describe('parseSummary — rejects empty + error results', () => {
  it('throws on an empty / whitespace-only summary', () => {
    expect(() => parseSummary(jobResult({ text: '' }))).toThrow(/empty summary/);
    expect(() => parseSummary(jobResult({ text: '   \n\t ' }))).toThrow(/empty summary/);
  });

  it('throws on an error envelope, naming the api_error_status', () => {
    expect(() =>
      parseSummary(jobResult({ isError: true, apiErrorStatus: 503, text: 'Service Unavailable' })),
    ).toThrow(/summarize job failed/);
  });

  it('rejects an empty summary that came back through the fake runner end-to-end', async () => {
    const runner = new FakeClaudeRunner({ byKind: { summarize: { text: '   ' } } });
    await expect(summarizeThread(runner, THREAD)).rejects.toThrow(/empty summary/);
  });
});

describe('buildSummarizeSpec + renderThreadPrompt — PURE assembly (§4)', () => {
  it('routes to summarize, supplies summarize.md, and uses a Read-only tool set', () => {
    const spec = buildSummarizeSpec(THREAD, { subject: 'v2 API spec' });
    expect(spec.taskKind).toBe('summarize');
    expect(spec.jsonSchema).toBeUndefined();
    expect(spec.allowedTools).toEqual(['Read']);
    expect(spec.systemPromptFile).toContain('summarize.md');
  });

  it('renders messages oldest → newest with their senders', () => {
    const prompt = renderThreadPrompt(THREAD, { subject: 'v2 API spec' });
    expect(prompt).toContain('Thread subject: v2 API spec');
    const firstIdx = prompt.indexOf('petr@fontai.cz');
    const secondIdx = prompt.indexOf('me@mailordomo');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx); // oldest first
    expect(prompt).toContain('--- Message 1 ---');
    expect(prompt).toContain('--- Message 2 ---');
  });
});
