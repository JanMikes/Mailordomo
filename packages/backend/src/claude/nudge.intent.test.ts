/**
 * INTENT-DERIVED behavioral suite for the sanctioned overdue-nudge auto-draft (PROJECT.md §6 /
 * Golden rule #1) via the FAKE Opus runner — no live call. Complements `nudge.test.ts` (the
 * implementer's smoke) by hardening the ONE invariant that matters most: the nudge produces a DRAFT
 * and has NO path to transmit. We prove it behaviorally with a HOSTILE filer that also exposes a
 * `send` spy — and assert that spy is never touched — plus the Opus routing floor and the prose
 * (no-`--json-schema`) shape.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClaudeRunner } from './fake-runner';
import { buildNudgeSpec, draftNudge } from './nudge';
import type { DraftFiler, NudgeContext, NudgeDraft, NudgeFiledResult } from './nudge';

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

/**
 * A filer that satisfies the save-only seam BUT also exposes a transmit verb. If the nudge path ever
 * reached for a way to send, `sendCalls` would be non-zero. It must stay at zero — structurally, the
 * nudge has only `saveDraft` to call.
 */
class HostileFiler implements DraftFiler {
  readonly saved: NudgeDraft[] = [];
  sendCalls = 0;
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.saved.push(draft);
    return Promise.resolve({ messageId: '<draft-123@local>', filedTo: 'Drafts' });
  }
  send(): Promise<void> {
    this.sendCalls += 1;
    return Promise.resolve();
  }
}

function opusRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner({
    byKind: {
      nudge: {
        // Untrimmed, multi-line: parseNudgeDraft should trim the ends but keep the body intact.
        text: '\n  Hi Petr,\n\nJust circling back on the signed contract — could you send it over? Thanks!\n  ',
        costUsd: 0.05,
        model: 'claude-opus-4-8',
      },
    },
  });
}

describe('draftNudge — files a DRAFT and never transmits (Golden rule #1)', () => {
  it('calls saveDraft exactly once with the right payload, and NEVER the transmit verb', async () => {
    const runner = opusRunner();
    const filer = new HostileFiler();

    const out = await draftNudge(runner, CONTEXT, filer);

    expect(filer.saved).toHaveLength(1);
    expect(filer.sendCalls).toBe(0); // the load-bearing invariant: no send, ever
    const saved = filer.saved[0];
    expect(saved?.to).toBe('petr@fontai.cz');
    expect(saved?.subject).toBe('Signed contract');
    expect(saved?.model).toBe('claude-opus-4-8');
    expect(saved?.author).toBe('claude'); // default actor = the daemon

    // The filed body IS the (trimmed) model output, with internal formatting preserved.
    expect(out.body).toBe(
      'Hi Petr,\n\nJust circling back on the signed contract — could you send it over? Thanks!',
    );
    expect(saved?.body).toBe(out.body);
    expect(out.filed).toEqual({ messageId: '<draft-123@local>', filedTo: 'Drafts' });
  });

  it('attributes a caller-supplied author on the filed draft', async () => {
    const filer = new HostileFiler();
    await draftNudge(opusRunner(), CONTEXT, filer, { author: 'jan' });
    expect(filer.saved[0]?.author).toBe('jan');
  });

  it('routes --model opus and uses a prose (no --json-schema) job', async () => {
    const runner = opusRunner();
    await draftNudge(runner, CONTEXT, new HostileFiler());
    const argv = runner.argv[0] ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv).not.toContain('--json-schema');
    expect(buildNudgeSpec(CONTEXT).jsonSchema).toBeUndefined();
  });
});
