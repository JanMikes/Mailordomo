/**
 * LOAD-BEARING — `parseClaudeJson` / `envelopeToJobResult` (PROJECT.md §4 + PLAN.md §4.8).
 *
 * The §4 verified envelope of `claude --output-format json` is the GROUND TRUTH:
 *   { result, structured_output, session_id, total_cost_usd,
 *     usage{input/output/cache tokens}, modelUsage, is_error, api_error_status, num_turns }
 * This is the seam the recorded fixtures replay through (§4.8) — NO live call. Derived assertions:
 *   - structuredOutput ← structured_output (present only when a schema was used);
 *   - text ← result; costUsd ← total_cost_usd (the NOTIONAL usage signal);
 *   - usage tokens ← usage{…}; model ← modelUsage's key, falling back to the alias when empty;
 *   - isError ← is_error; apiErrorStatus ← api_error_status (only when non-null);
 *   - defensive: an error envelope and malformed/empty stdout must not crash the runner.
 *
 * We replay the committed fixtures (always present) AND, when available, the machine-local
 * `/tmp/claude_groundtruth.json` capture the fixtures derive from — the latter is read defensively
 * so the suite stays hermetic in CI where that file does not exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRIAGE_FIXTURE } from './__fixtures__/llm/triage.fixture';
import { SUMMARIZE_FIXTURE } from './__fixtures__/llm/summarize.fixture';
import { ClaudeParseError, envelopeToJobResult, parseClaudeJson } from './parse-json';
import type { ClaudeJsonEnvelope } from './types';

const GROUNDTRUTH_PATH = '/tmp/claude_groundtruth.json';

describe('parseClaudeJson — the GROUND-TRUTH triage envelope maps field-for-field', () => {
  it('maps total_cost_usd, usage tokens, model id, structured_output, ids (from the fixture)', () => {
    const result = envelopeToJobResult(TRIAGE_FIXTURE, 'haiku');
    expect(result.costUsd).toBeCloseTo(0.04118875, 10);
    expect(result.text).toBe(''); // a pure-structured job returns an empty `result`
    expect(result.model).toBe('claude-haiku-4-5-20251001'); // from modelUsage's key
    expect(result.usage).toEqual({
      inputTokens: 18,
      outputTokens: 294,
      cacheCreationInputTokens: 29011,
      cacheReadInputTokens: 28770,
      serviceTier: 'standard',
    });
    expect(result.isError).toBe(false);
    expect(result.apiErrorStatus).toBeUndefined(); // api_error_status was null
    expect(result.sessionId).toBe('847e32d1-529d-4688-8c0e-1570ba28c821');
    expect(result.numTurns).toBe(2);
    expect(result.durationMs).toBe(4461);
    expect(result.structuredOutput).toMatchObject({
      disposition: 'needs-reply',
      needs_reply: true,
      importance: 'high',
    });
  });

  it('parses the raw captured /tmp file IDENTICALLY when present (defensive: skipped in CI)', () => {
    if (!existsSync(GROUNDTRUTH_PATH)) {
      // The capture is machine-local and not in the repo; the committed fixture covers CI.
      return;
    }
    const raw = readFileSync(GROUNDTRUTH_PATH, 'utf8');
    const result = parseClaudeJson(raw, 'haiku');
    expect(result.costUsd).toBeCloseTo(0.04118875, 10);
    expect(result.model).toBe('claude-haiku-4-5-20251001');
    expect(result.isError).toBe(false);
    expect(result.usage.cacheCreationInputTokens).toBe(29011);
    expect(result.structuredOutput).toBeDefined();
  });
});

describe('parseClaudeJson — the summarize (free-text) envelope', () => {
  it('carries text from `result` and has NO structuredOutput (no --json-schema)', () => {
    const result = envelopeToJobResult(SUMMARIZE_FIXTURE, 'sonnet');
    expect(result.structuredOutput).toBeUndefined();
    expect(result.text).toContain('API spec');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.costUsd).toBeCloseTo(0.0193245, 10);
  });

  it('round-trips through the STRING parser (stdout text → JobResult)', () => {
    const result = parseClaudeJson(JSON.stringify(SUMMARIZE_FIXTURE), 'sonnet');
    expect(result.text).toContain('staging outage');
    expect(result.model).toBe('claude-sonnet-4-6');
  });
});

describe('parseClaudeJson — model id fallback to the requested alias', () => {
  it('falls back to the alias when modelUsage is absent', () => {
    const envelope: ClaudeJsonEnvelope = { result: 'ok', total_cost_usd: 0.01 };
    expect(envelopeToJobResult(envelope, 'opus').model).toBe('opus');
  });

  it('falls back to the alias when modelUsage is present but EMPTY', () => {
    const envelope: ClaudeJsonEnvelope = { result: 'ok', modelUsage: {} };
    expect(envelopeToJobResult(envelope, 'sonnet').model).toBe('sonnet');
  });

  it('prefers the modelUsage key over the alias when present', () => {
    const envelope: ClaudeJsonEnvelope = {
      result: 'ok',
      modelUsage: { 'claude-opus-4-8': { costUSD: 0.5 } },
    };
    expect(envelopeToJobResult(envelope, 'haiku').model).toBe('claude-opus-4-8');
  });
});

describe('parseClaudeJson — error envelope (is_error: true)', () => {
  it('surfaces isError + apiErrorStatus from an upstream-failed envelope (no throw)', () => {
    const envelope: ClaudeJsonEnvelope = {
      type: 'result',
      is_error: true,
      api_error_status: 529,
      result: 'Overloaded',
      session_id: 'err-1',
      total_cost_usd: 0,
    };
    const result = envelopeToJobResult(envelope, 'haiku');
    expect(result.isError).toBe(true);
    expect(result.apiErrorStatus).toBe(529);
    expect(result.text).toBe('Overloaded');
    expect(result.structuredOutput).toBeUndefined();
  });

  it('treats a missing is_error as not-an-error and a null api_error_status as undefined', () => {
    const result = envelopeToJobResult({ result: 'fine' }, 'haiku');
    expect(result.isError).toBe(false);
    expect(result.apiErrorStatus).toBeUndefined();
  });
});

describe('parseClaudeJson — defensive parsing of bad stdout', () => {
  it('throws ClaudeParseError on EMPTY stdout (CLI emitted nothing)', () => {
    expect(() => parseClaudeJson('   ')).toThrow(ClaudeParseError);
  });

  it('throws ClaudeParseError on NON-JSON stdout, preserving the raw text', () => {
    let caught: unknown;
    try {
      parseClaudeJson('claude: command crashed\nstack trace…');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeParseError);
    expect((caught as ClaudeParseError).raw).toContain('command crashed');
  });

  it('defaults numeric fields to 0 and text to "" for a sparse but valid envelope', () => {
    const result = parseClaudeJson('{}', 'haiku');
    expect(result.text).toBe('');
    expect(result.costUsd).toBe(0);
    expect(result.numTurns).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(result.sessionId).toBe('');
    expect(result.model).toBe('haiku'); // fallback alias
  });
});

describe('structured_output handling — present vs absent', () => {
  it('a schema-d envelope exposes structuredOutput as the OBJECT (not stringified)', () => {
    const envelope: ClaudeJsonEnvelope = {
      result: '',
      structured_output: { disposition: 'fyi', n: 1 },
    };
    const result = envelopeToJobResult(envelope, 'haiku');
    expect(result.structuredOutput).toEqual({ disposition: 'fyi', n: 1 });
    expect(typeof result.structuredOutput).toBe('object');
  });

  it('a no-schema envelope omits structuredOutput entirely (key absent, not null)', () => {
    const result = envelopeToJobResult({ result: 'prose' }, 'sonnet');
    expect('structuredOutput' in result).toBe(false);
    expect(result.text).toBe('prose');
  });
});
