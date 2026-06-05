/**
 * SMOKE — the sanctioned overdue-nudge auto-draft (PROJECT.md §6 / Golden rule #1) via the FAKE
 * runner. No live call. Thin coverage; the SEPARATE test-author writes the load-bearing behavioral
 * suite (assert no send path reachable from the daemon). Here we pin the structural guarantees:
 *  - the spec routes to OPUS (Golden rule #6 — outgoing text never below Opus);
 *  - drafting produces a DRAFT via the injected saveDraft-only filer — and ONLY saveDraft is called,
 *    never a transmit (the filer interface has no send verb);
 *  - error/empty drafts are rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClaudeRunner } from './fake-runner';
import { buildNudgeSpec, draftNudge, parseNudgeDraft, renderNudgePrompt } from './nudge';
import type { DraftFiler, NudgeContext, NudgeDraft, NudgeFiledResult } from './nudge';
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

const CONTEXT: NudgeContext = {
  promise: {
    text: 'Petr sends the signed contract',
    due_at: '2026-06-01T21:59:59.000Z',
    due_raw: 'by last Tuesday',
    direction: 'awaiting-them',
    status: 'overdue',
  },
  recipient: 'petr@fontai.cz',
  subject: 'Signed contract',
  nowIso: '2026-06-05T12:00:00Z',
};

/** A capturing saveDraft-ONLY filer. It records every saveDraft call; it has no way to transmit. */
class CapturingFiler implements DraftFiler {
  readonly saved: NudgeDraft[] = [];
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.saved.push(draft);
    return Promise.resolve({ messageId: '<draft@local>', filedTo: 'Drafts' });
  }
}

describe('buildNudgeSpec — the PURE nudge job spec (§6/§4)', () => {
  it('routes to OPUS with the nudge prompt and no json schema (prose draft)', () => {
    const spec = buildNudgeSpec(CONTEXT);
    expect(spec.taskKind).toBe('nudge');
    expect(spec.systemPromptFile).toContain('nudge.md');
    expect(spec.jsonSchema).toBeUndefined();
    expect(spec.allowedTools).toEqual(['Read']);
  });
});

describe('renderNudgePrompt — grounds the chase in the lapsed promise', () => {
  it('includes the recipient, subject, the commitment, and both deadlines', () => {
    const prompt = renderNudgePrompt(CONTEXT);
    expect(prompt).toContain('petr@fontai.cz');
    expect(prompt).toContain('Signed contract');
    expect(prompt).toContain('Petr sends the signed contract');
    expect(prompt).toContain('by last Tuesday');
  });
});

describe('draftNudge — produces a DRAFT via saveDraft, never a send (Golden rule #1)', () => {
  it('routes Opus, drafts the body, and FILES it via saveDraft only', async () => {
    const runner = new FakeClaudeRunner({
      byKind: {
        nudge: {
          text: 'Hi Petr, just following up on the signed contract — any update? Thanks!',
          costUsd: 0.05,
          model: 'claude-opus-4-8',
        },
      },
    });
    const filer = new CapturingFiler();

    const out = await draftNudge(runner, CONTEXT, filer);

    // A draft body came back and was filed (not sent).
    expect(out.body).toContain('following up');
    expect(out.filed.filedTo).toBe('Drafts');
    expect(out.costUsd).toBeCloseTo(0.05, 6);

    // EXACTLY ONE saveDraft call; the captured draft carries the model + the daemon as author.
    expect(filer.saved).toHaveLength(1);
    expect(filer.saved[0]?.to).toBe('petr@fontai.cz');
    expect(filer.saved[0]?.subject).toBe('Signed contract');
    expect(filer.saved[0]?.model).toBe('claude-opus-4-8');
    expect(filer.saved[0]?.author).toBe('claude');

    // Routing: the built argv carries --model opus (Golden rule #6 floor).
    const argv = runner.argv[0] ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  });

  it('the DraftFiler seam is save-only — there is no transmit method on the surface', () => {
    const filer: DraftFiler = new CapturingFiler();
    // Structural: the only verb is saveDraft. (A transmit method would have to be added explicitly,
    // and the daemon is ESLint-barred from importing smtp/** anyway.)
    expect(typeof filer.saveDraft).toBe('function');
    expect(Object.keys(filer)).not.toContain('send');
  });
});

describe('parseNudgeDraft — rejects empty/error drafts', () => {
  function jobResult(over: Partial<JobResult>): JobResult {
    return {
      text: '',
      model: 'claude-opus-4-8',
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
  it('throws on an empty draft', () => {
    expect(() => parseNudgeDraft(jobResult({ text: '   ' }))).toThrow(/empty draft/);
  });
  it('throws on an error envelope', () => {
    expect(() =>
      parseNudgeDraft(jobResult({ isError: true, apiErrorStatus: 500, text: 'boom' })),
    ).toThrow(/nudge job failed/);
  });
});
