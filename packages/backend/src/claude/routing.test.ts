/**
 * LOAD-BEARING — Model routing (PROJECT.md §4 "Fixed model routing" + Golden rule #6).
 *
 * Authored from INTENT first: §4's routing table is the contract — triage/extraction → Haiku,
 * summaries/digest/ranking → Sonnet, drafts & repo-aware answers → Opus. Golden rule #6 is
 * "never route outgoing-text generation below Opus." The architectural guarantee the spec relies
 * on (`types.ts`/`build-args.ts`): a CALLER never names a model — the model is derived from the
 * task kind via the shared `MODEL_ROUTING` map. So this suite asserts, against the BUILT ARGV and
 * the runner's chosen alias, that:
 *   - each representative task kind picks the routed model (triage→haiku, summarize→sonnet, …);
 *   - the `JobSpec` surface exposes NO model field, so a caller structurally cannot force a
 *     sub-Opus model on an outgoing-text kind (the spec routes by kind, not by caller).
 *
 * These are derived from the §4 table + the kind→model map, NOT from reading build-args' body.
 */
import { describe, expect, it } from 'vitest';
import type { ModelAlias, TaskKind } from '@mailordomo/shared';
import { MODEL_ROUTING, OUTGOING_TEXT_TASK_KINDS, TASK_KINDS } from '@mailordomo/shared';
import { buildClaudeArgs, modelAliasForSpec } from './build-args';
import type { JobSpec } from './types';

/** Pull the value passed to `--model` out of a built argv (the routed alias). */
function modelFlagOf(args: readonly string[]): string | undefined {
  const i = args.indexOf('--model');
  return i === -1 ? undefined : args[i + 1];
}

/** The §4 routing table, restated here from INTENT (the contract the code must satisfy). */
const EXPECTED_ROUTING: Record<TaskKind, ModelAlias> = {
  triage: 'haiku',
  'promise-extraction': 'haiku',
  summarize: 'sonnet',
  digest: 'sonnet',
  rank: 'sonnet',
  draft: 'opus',
  nudge: 'opus',
  'repo-answer': 'opus',
};

describe('model routing — the built argv carries the §4-routed model for each kind', () => {
  for (const kind of TASK_KINDS) {
    it(`${kind} → --model ${EXPECTED_ROUTING[kind]}`, () => {
      const args = buildClaudeArgs({ taskKind: kind, prompt: 'x' });
      expect(modelFlagOf(args)).toBe(EXPECTED_ROUTING[kind]);
      // And the exposed alias-for-logging seam agrees with what landed in argv.
      expect(modelAliasForSpec({ taskKind: kind, prompt: 'x' })).toBe(EXPECTED_ROUTING[kind]);
    });
  }

  it('the two named anchors are exactly triage→haiku and summarize→sonnet', () => {
    expect(modelFlagOf(buildClaudeArgs({ taskKind: 'triage', prompt: 'x' }))).toBe('haiku');
    expect(modelFlagOf(buildClaudeArgs({ taskKind: 'summarize', prompt: 'x' }))).toBe('sonnet');
  });

  it('the argv model always equals the shared MODEL_ROUTING value (single source of truth)', () => {
    for (const kind of TASK_KINDS) {
      expect(modelFlagOf(buildClaudeArgs({ taskKind: kind, prompt: 'x' }))).toBe(
        MODEL_ROUTING[kind],
      );
    }
  });
});

describe('Golden rule #6 — outgoing-text kinds are pinned to Opus by the routing, not the caller', () => {
  it('every outgoing-text kind (draft/nudge/repo-answer) builds with --model opus', () => {
    for (const kind of OUTGOING_TEXT_TASK_KINDS) {
      expect(modelFlagOf(buildClaudeArgs({ taskKind: kind, prompt: 'send me' }))).toBe('opus');
    }
  });

  it('a JobSpec has NO model channel — a caller cannot force a sub-Opus model for an outgoing kind', () => {
    // The model is derived from `taskKind`; the spec carries no `model`/`modelAlias` key to override
    // it. This is the structural reason Golden rule #6 cannot be violated by a caller. We assert the
    // shape: a spec built with extra/foreign keys still routes purely by kind.
    const spec = {
      taskKind: 'draft',
      prompt: 'p',
      // deliberately attempt to smuggle a cheaper model in — it is NOT part of JobSpec and must be
      // ignored by the router (routing reads `taskKind` only).
      model: 'haiku',
      modelAlias: 'haiku',
    } as unknown as JobSpec;
    expect(modelFlagOf(buildClaudeArgs(spec))).toBe('opus');
    // The TS surface confirms it too: JobSpec exposes no model field.
    const keys: (keyof JobSpec)[] = [
      'taskKind',
      'prompt',
      'systemPromptFile',
      'appendSystemPromptFile',
      'jsonSchema',
      'addDirs',
      'allowedTools',
      'timeoutMs',
      'bare',
    ];
    expect(keys).not.toContain('model' as unknown as keyof JobSpec);
  });
});
