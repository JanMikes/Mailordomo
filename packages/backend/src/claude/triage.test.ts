/**
 * LOAD-BEARING — Triage → state mapping (PROJECT.md §6 + §4) via the FAKE runner. No live call.
 *
 * Derived from §6 INTENT, NOT the code:
 *   - A triaged inbound is mapped to a state-machine EVENT, then resolved against the thread's
 *     CURRENT state. §6 fixes which transitions auto-apply vs are proposed:
 *       · inbound "thanks" (no reply needed) auto-closes a `needs-reply` thread → done (the one
 *         explicit §6 auto-close); from any OTHER live state it is a judgement call → propose (or
 *         noop where there is no edge / already there);
 *       · a new inbound on a non-needs-reply thread re-obligates/reopens it → needs-reply, which is
 *         a judgement call everywhere it applies → propose (noop when already needs-reply);
 *       · an `fyi` is informational → no event, no transition.
 *
 * The EXPECTED matrix below is written from that §6 reading. `triageMessage` is then exercised with
 * the fake runner across ALL FIVE `from` states and checked against it. `resolveEvent` is the shared
 * engine; we assert triage drives it correctly (apply/propose/noop) — we do not re-test the engine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskState } from '@mailordomo/shared';
import { TASK_STATES } from '@mailordomo/shared';
import { FakeClaudeRunner } from './fake-runner';
import { buildTriageSpec, dispositionToEvent, parseTriageDecision, triageMessage } from './triage';
import { TriageDecisionSchema, TRIAGE_JSON_SCHEMA } from './triage-schema';
import type { TriageDecision } from './triage-schema';
import type { TaskEvent } from '../engines/state-machine';
import type { JobResult } from './types';

// Point prompt resolution at the real repo `prompts/` dir so `buildTriageSpec` (→ promptPath) works
// regardless of where vitest's cwd lands. The dir holds triage.md + summarize.md (Phase 4).
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

/** Build a valid triage decision for a disposition (other fields don't affect the mapping). */
function decision(disposition: TriageDecision['disposition']): TriageDecision {
  return TriageDecisionSchema.parse({
    disposition,
    needs_reply: disposition === 'needs-reply',
    importance: 'normal',
    confidence: 'high',
    reason: `test reason for ${disposition}`,
  });
}

/** A fake runner whose triage job returns the given structured decision. */
function runnerReturning(d: TriageDecision): FakeClaudeRunner {
  return new FakeClaudeRunner({ byKind: { triage: { structuredOutput: d } } });
}

const MSG = { subject: 's', sender: 'a@b.c', snippet: 'snippet text' } as const;

describe('dispositionToEvent — the §6 disposition → event mapping', () => {
  it('needs-reply → new-inbound', () => {
    expect(dispositionToEvent(decision('needs-reply'))).toBe('new-inbound');
  });
  it('no-reply-needed → inbound-thanks (the §6 auto-close signal)', () => {
    expect(dispositionToEvent(decision('no-reply-needed'))).toBe('inbound-thanks');
  });
  it('fyi → null (informational; no state change)', () => {
    expect(dispositionToEvent(decision('fyi'))).toBeNull();
  });
});

/**
 * EXPECTED outcome of triage from every `from` state, derived from §6 + the graph. Each value is the
 * `transition.kind` (or 'noop' with its reason where relevant). Written from intent.
 */
type Kind = 'apply' | 'propose' | 'noop';

const NEW_INBOUND_EXPECTED: Record<TaskState, Kind> = {
  'needs-reply': 'noop', // already in target needs-reply
  drafted: 'propose', // reopen/re-obligate — judgement call
  waiting: 'propose',
  'follow-up': 'propose',
  done: 'propose', // a closed thread reopened by new mail — proposed
};

const INBOUND_THANKS_EXPECTED: Record<TaskState, Kind> = {
  'needs-reply': 'apply', // §6 explicit AUTO: inbound "thanks" → done
  drafted: 'noop', // no drafted→done edge in the graph
  waiting: 'propose', // mid-thread thanks while awaiting — judgement call
  'follow-up': 'propose',
  done: 'noop', // already done
};

describe('triageMessage — needs-reply disposition across ALL FIVE from-states (fake runner)', () => {
  for (const from of TASK_STATES) {
    it(`from ${from}: → new-inbound, transition ${NEW_INBOUND_EXPECTED[from]}`, async () => {
      const runner = runnerReturning(decision('needs-reply'));
      const out = await triageMessage(runner, MSG, from);
      expect(out.event).toBe('new-inbound' satisfies TaskEvent);
      expect(out.transition?.kind ?? 'noop').toBe(NEW_INBOUND_EXPECTED[from]);
      if (NEW_INBOUND_EXPECTED[from] !== 'noop') {
        expect(out.transition).toMatchObject({ from, to: 'needs-reply' });
      }
    });
  }
});

describe('triageMessage — no-reply-needed disposition across ALL FIVE from-states (fake runner)', () => {
  for (const from of TASK_STATES) {
    it(`from ${from}: → inbound-thanks, transition ${INBOUND_THANKS_EXPECTED[from]}`, async () => {
      const runner = runnerReturning(decision('no-reply-needed'));
      const out = await triageMessage(runner, MSG, from);
      expect(out.event).toBe('inbound-thanks' satisfies TaskEvent);
      expect(out.transition?.kind ?? 'noop').toBe(INBOUND_THANKS_EXPECTED[from]);
      if (INBOUND_THANKS_EXPECTED[from] === 'apply') {
        expect(out.transition).toMatchObject({ from, to: 'done', mode: 'auto' });
      }
      if (INBOUND_THANKS_EXPECTED[from] === 'propose') {
        expect(out.transition).toMatchObject({ from, to: 'done', mode: 'propose' });
      }
    });
  }

  it('the ONE §6 auto-close is exactly needs-reply →(inbound-thanks)→ done (apply/auto)', async () => {
    const runner = runnerReturning(decision('no-reply-needed'));
    const out = await triageMessage(runner, MSG, 'needs-reply');
    expect(out.transition).toEqual({
      kind: 'apply',
      from: 'needs-reply',
      to: 'done',
      event: 'inbound-thanks',
      mode: 'auto',
    });
  });
});

describe('triageMessage — fyi disposition produces no event and no transition (any state)', () => {
  for (const from of TASK_STATES) {
    it(`from ${from}: event null, transition null`, async () => {
      const runner = runnerReturning(decision('fyi'));
      const out = await triageMessage(runner, MSG, from);
      expect(out.event).toBeNull();
      expect(out.transition).toBeNull();
    });
  }
});

describe('triageMessage — surfaces the call accounting + drives the right spec', () => {
  it('returns costUsd + model from the underlying job and routes through a Haiku triage spec', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        triage: {
          structuredOutput: decision('needs-reply'),
          costUsd: 0.012,
          model: 'claude-haiku-4-5',
        },
      },
    });
    const out = await triageMessage(runner, MSG, 'done');
    expect(out.costUsd).toBeCloseTo(0.012, 6);
    expect(out.model).toBe('claude-haiku-4-5');
    // The spec the fake received is a triage spec (Haiku via routing, schema-constrained).
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.taskKind).toBe('triage');
    expect(runner.calls[0]?.jsonSchema).toBe(TRIAGE_JSON_SCHEMA);
    // Routing: the built argv for that call carries --model haiku.
    const argv = runner.argv[0] ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
  });
});

describe('buildTriageSpec — the PURE triage job spec (§4)', () => {
  it('is taskKind triage with the triage schema, Read tool, and a stdin prompt (not argv)', () => {
    const spec = buildTriageSpec(MSG);
    expect(spec.taskKind).toBe('triage');
    expect(spec.jsonSchema).toBe(TRIAGE_JSON_SCHEMA);
    expect(spec.allowedTools).toEqual(['Read']);
    expect(spec.systemPromptFile).toContain('triage.md');
    expect(spec.prompt).toContain(MSG.sender);
    expect(spec.prompt).toContain(MSG.subject);
  });

  it('threads addDirs/timeoutMs/bare through only when supplied', () => {
    const bare = buildTriageSpec(MSG);
    expect(bare.addDirs).toBeUndefined();
    expect(bare.timeoutMs).toBeUndefined();
    expect(bare.bare).toBeUndefined();
    const full = buildTriageSpec({ ...MSG, addDirs: ['/repo'] }, { timeoutMs: 5000, bare: true });
    expect(full.addDirs).toEqual(['/repo']);
    expect(full.timeoutMs).toBe(5000);
    expect(full.bare).toBe(true);
  });
});

describe('TriageDecisionSchema — rejects malformed decisions (defense in depth)', () => {
  it('rejects an unknown disposition', () => {
    expect(() =>
      TriageDecisionSchema.parse({
        disposition: 'archive',
        needs_reply: false,
        importance: 'low',
        confidence: 'high',
        reason: 'x',
      }),
    ).toThrow();
  });

  it('rejects a missing required field (needs_reply)', () => {
    expect(() =>
      TriageDecisionSchema.parse({
        disposition: 'fyi',
        importance: 'low',
        confidence: 'high',
        reason: 'x',
      }),
    ).toThrow();
  });

  it('rejects an out-of-enum importance and an empty reason', () => {
    expect(() =>
      TriageDecisionSchema.parse({
        disposition: 'fyi',
        needs_reply: false,
        importance: 'critical',
        confidence: 'high',
        reason: 'x',
      }),
    ).toThrow();
    expect(() =>
      TriageDecisionSchema.parse({
        disposition: 'fyi',
        needs_reply: false,
        importance: 'low',
        confidence: 'high',
        reason: '',
      }),
    ).toThrow();
  });
});

describe('parseTriageDecision — validates structured_output and rejects error envelopes', () => {
  it('parses a good structured_output into a TriageDecision', () => {
    const result: JobResult = {
      structuredOutput: decision('needs-reply'),
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
    };
    expect(parseTriageDecision(result).disposition).toBe('needs-reply');
  });

  it('throws when the job came back as an error envelope', () => {
    const result: JobResult = {
      text: 'Overloaded',
      model: 'claude-haiku-4-5',
      costUsd: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      isError: true,
      apiErrorStatus: 529,
      sessionId: 's',
      numTurns: 1,
      durationMs: 0,
    };
    expect(() => parseTriageDecision(result)).toThrow(/triage job failed/);
  });

  it('throws when structured_output is missing/garbage (the schema rejects it)', () => {
    const result: JobResult = {
      structuredOutput: { not: 'a decision' },
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
    };
    expect(() => parseTriageDecision(result)).toThrow();
  });
});
