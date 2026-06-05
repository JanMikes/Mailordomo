/**
 * Smoke tests for the on-signal drafter + replay-based refine (Phase 7b, D31). Uses the FAKE runner —
 * no API. Proves: Opus routing (golden rule #6), the layered tone file flows onto `--append-system-
 * prompt-file`, the transcript is built correctly, and refine REPLAYS full history (golden rule #5,
 * never `--continue`/`--resume`). The exhaustive suite is the separate test-author's job.
 */
import { describe, expect, it } from 'vitest';
import { modelForTask } from '@mailordomo/shared';
import type { RefineTurn } from '../drafts/types';
import { buildClaudeArgs } from './build-args';
import { buildDraftSpec, generateDraft, refineDraft } from './draft';
import type { DraftContext } from './draft';
import { FakeClaudeRunner } from './fake-runner';

const context: DraftContext = {
  subject: 'Invoice question',
  recipient: 'Client <client@acme.com>',
  messages: [
    { sender: 'client@acme.com', date: '2026-06-05T09:00:00.000Z', body: 'Can you clarify?' },
  ],
  instructionText: 'be brief',
};

describe('generateDraft — Opus, text-only, transcript', () => {
  it('routes draft to opus and never names a model or uses --continue/--resume', async () => {
    const runner = new FakeClaudeRunner({ byKind: { draft: { text: 'DRAFT BODY' } } });
    const gen = await generateDraft(runner, context);

    expect(gen.body).toBe('DRAFT BODY');
    expect(gen.model).toBe('opus');
    expect(gen.model).toBe(modelForTask('draft'));
    expect(gen.transcript).toEqual<RefineTurn[]>([
      { role: 'user', content: 'be brief' },
      { role: 'assistant', content: 'DRAFT BODY' },
    ]);

    expect(runner.calls[0]?.taskKind).toBe('draft');
    const argv = runner.argv[0] ?? [];
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv).not.toContain('--continue');
    expect(argv).not.toContain('--resume');
  });

  it('falls back to a default instruction when none is given', async () => {
    const runner = new FakeClaudeRunner({ byKind: { draft: { text: 'BODY' } } });
    const gen = await generateDraft(runner, {
      subject: 'Hi',
      messages: [{ sender: 'a@b', body: 'x' }],
    });
    expect(gen.transcript[0]?.role).toBe('user');
    expect(gen.transcript[0]?.content).toMatch(/draft a reply/i);
  });
});

describe('buildDraftSpec — layers the resolved tone file', () => {
  it('passes the tone file onto --append-system-prompt-file', () => {
    const spec = buildDraftSpec('PROMPT', { appendSystemPromptFile: '/tmp/tone.md' });
    expect(spec.taskKind).toBe('draft');
    expect(spec.appendSystemPromptFile).toBe('/tmp/tone.md');
    const argv = buildClaudeArgs(spec);
    expect(argv).toContain('--append-system-prompt-file');
    expect(argv[argv.indexOf('--append-system-prompt-file') + 1]).toBe('/tmp/tone.md');
  });

  it('omits the append flag when no tone file is resolved', () => {
    const spec = buildDraftSpec('PROMPT');
    expect(spec.appendSystemPromptFile).toBeUndefined();
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt-file');
  });
});

describe('refineDraft — REPLAYS full history into a fresh call (golden rule #5)', () => {
  it('replays the prior transcript + new instruction and extends the transcript', async () => {
    const prior: RefineTurn[] = [
      { role: 'user', content: 'be brief' },
      { role: 'assistant', content: 'DRAFT BODY' },
    ];
    const runner = new FakeClaudeRunner({ byKind: { draft: { text: 'REFINED BODY' } } });
    const gen = await refineDraft(runner, context, prior, 'make it warmer');

    expect(gen.body).toBe('REFINED BODY');
    expect(gen.transcript).toEqual<RefineTurn[]>([
      ...prior,
      { role: 'user', content: 'make it warmer' },
      { role: 'assistant', content: 'REFINED BODY' },
    ]);

    // The single fresh -p call carries the REPLAYED history + the new instruction (no session resume).
    const prompt = runner.calls[0]?.prompt ?? '';
    expect(prompt).toContain('DRAFT BODY'); // prior assistant draft replayed
    expect(prompt).toContain('be brief'); // prior user instruction replayed
    expect(prompt).toContain('make it warmer'); // the new instruction
    const argv = runner.argv[0] ?? [];
    expect(argv).not.toContain('--continue');
    expect(argv).not.toContain('--resume');
  });
});
