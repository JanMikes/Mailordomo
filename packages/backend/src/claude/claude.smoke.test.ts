/**
 * MINIMAL smoke tests for the Phase 4 Claude engine — just enough to prove the pipeline wires
 * together end-to-end with NO live API. The LOAD-BEARING suite (exhaustive routing, full argv
 * assembly, parse edge cases, structured_output handling, triage→state matrix, usage-throttle
 * window/backpressure, the ANTHROPIC_API_KEY warning) is written by a SEPARATE test-author per the
 * §4.4 role split. These tests must never call live `claude`; they use the fake runner and the
 * recorded fixtures.
 */
import { describe, expect, it } from 'vitest';
import { TRIAGE_FIXTURE } from './__fixtures__/llm/triage.fixture';
import { SUMMARIZE_FIXTURE } from './__fixtures__/llm/summarize.fixture';
import { buildClaudeArgs } from './build-args';
import { envelopeToJobResult, parseClaudeJson } from './parse-json';
import { FakeClaudeRunner } from './fake-runner';
import { UsageThrottle } from './throttle';
import { warnIfAnthropicApiKeySet } from './subscription';
import { ClaudeJobQueue } from './queue';
import { TriageDecisionSchema } from './triage-schema';
import { dispositionToEvent, parseTriageDecision, triageMessage } from './triage';
import { parseSummary, summarizeThread } from './summarize';

describe('buildClaudeArgs (pure)', () => {
  it('routes triage to haiku and includes the json envelope + json-schema + read-only flags', () => {
    const args = buildClaudeArgs({
      taskKind: 'triage',
      prompt: 'hello',
      systemPromptFile: '/p/triage.md',
      jsonSchema: { type: 'object' },
      allowedTools: ['Read'],
    });
    expect(args).toContain('-p');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args).toContain('--json-schema');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    // The prompt is NEVER an argv (it goes via stdin).
    expect(args).not.toContain('hello');
  });

  it('routes summarize to sonnet', () => {
    const args = buildClaudeArgs({ taskKind: 'summarize', prompt: 'x' });
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });
});

describe('parseClaudeJson (pure) replays recorded fixtures', () => {
  it('maps the triage fixture envelope to a JobResult with structured_output + cost + model', () => {
    const result = envelopeToJobResult(TRIAGE_FIXTURE, 'haiku');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.costUsd).toBeCloseTo(0.04118875, 8);
    expect(result.isError).toBe(false);
    const decision = TriageDecisionSchema.parse(result.structuredOutput);
    expect(decision.disposition).toBe('needs-reply');
    expect(decision.needs_reply).toBe(true);
  });

  it('maps the summarize fixture envelope to free-text with no structured_output', () => {
    const result = envelopeToJobResult(SUMMARIZE_FIXTURE, 'sonnet');
    expect(result.structuredOutput).toBeUndefined();
    expect(result.text).toContain('API spec');
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('round-trips through the string parser too', () => {
    const result = parseClaudeJson(JSON.stringify(TRIAGE_FIXTURE), 'haiku');
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe('triage consumer maps a decision to a state-machine event (fake runner)', () => {
  it('needs-reply disposition → new-inbound event → needs-reply state', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        triage: {
          structuredOutput: parseTriageDecision(envelopeToJobResult(TRIAGE_FIXTURE, 'haiku')),
        },
      },
    });
    const out = await triageMessage(
      runner,
      { subject: 's', sender: 'a@b.c', snippet: 'help, prod is down' },
      'done',
    );
    expect(out.event).toBe('new-inbound');
    expect(out.transition?.kind).toBe('propose'); // done → needs-reply is a proposed reopen
  });

  it('no-reply-needed → inbound-thanks event (auto-closes from needs-reply)', () => {
    expect(
      dispositionToEvent(
        TriageDecisionSchema.parse({
          disposition: 'no-reply-needed',
          needs_reply: false,
          importance: 'low',
          confidence: 'high',
          reason: 'just a thanks',
        }),
      ),
    ).toBe('inbound-thanks');
  });

  it('fyi disposition → no event (no state change)', () => {
    expect(
      dispositionToEvent(
        TriageDecisionSchema.parse({
          disposition: 'fyi',
          needs_reply: false,
          importance: 'low',
          confidence: 'high',
          reason: 'newsletter',
        }),
      ),
    ).toBeNull();
  });
});

describe('summarize consumer (fake runner)', () => {
  it('returns the prose summary from the result text', async () => {
    const runner = new FakeClaudeRunner({
      byKind: { summarize: { text: 'A tidy summary of the thread.' } },
    });
    const out = await summarizeThread(runner, [{ sender: 'a@b.c', body: 'hello world' }]);
    expect(out.summary).toBe('A tidy summary of the thread.');
  });

  it('rejects an empty summary', () => {
    expect(() =>
      parseSummary({
        text: '   ',
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
      }),
    ).toThrow();
  });
});

describe('queue + usage-throttle backpressure (injected clock + usage window)', () => {
  const fixedClock = { now: () => new Date('2026-06-05T10:00:00Z') };

  it('runs jobs and accumulates usage; defers a deferrable job once over the throttle', async () => {
    const runner = new FakeClaudeRunner({ fallback: { costUsd: 3.0 } });
    const throttle = new UsageThrottle({ throttle: 5.0, clock: fixedClock, logger: () => {} });
    const queue = new ClaudeJobQueue(runner, { concurrency: 1, throttle });

    // First summarize: within throttle, records 3.0 of usage (window total 3.0).
    await queue.enqueue({ taskKind: 'summarize', prompt: 'a' });
    // Second summarize: still within throttle at dispatch (3.0 < 5.0), records 3.0 (window total 6.0).
    await queue.enqueue({ taskKind: 'summarize', prompt: 'b' });
    expect(throttle.usageInWindow()).toBeCloseTo(6.0, 6);

    // Now over the throttle: a deferrable summarize is refused; an essential triage still runs.
    await expect(queue.enqueue({ taskKind: 'summarize', prompt: 'c' })).rejects.toThrow();
    await expect(queue.enqueue({ taskKind: 'triage', prompt: 'd' })).resolves.toBeDefined();
  });
});

describe('subscription guard (warnIfAnthropicApiKeySet)', () => {
  it('warns when ANTHROPIC_API_KEY is set and stays quiet when it is not', () => {
    const warnings: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    };
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' }, logger })).toBe(
      true,
    );
    expect(warnIfAnthropicApiKeySet({ env: {}, logger })).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
