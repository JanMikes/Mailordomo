/**
 * LIGHT smoke tests for the Phase 6 learning module — proving the modules WIRE + EXPORT and that the
 * silent-learning flow runs end-to-end through the real seams (fake runner + REAL in-process server +
 * real tone store/log). The LOAD-BEARING intent-derived suite (signal edge cases, the privacy
 * boundary, revert idempotency, stacked-revert semantics) is the SEPARATE test-author's job
 * (PLAN.md §4.4).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, FakeClaudeRunner, isEssentialTask } from '../claude';
import type { JobResult } from '../claude';
import { ToneStore } from '../tone/store';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { draftVsSentDiff, recurringInstructions } from './signals';
import { LEARN_JSON_SCHEMA, LearnOutputSchema } from './learn-schema';
import { LearningLog } from './log';
import {
  appendLesson,
  applyLearning,
  buildLearnSpec,
  parseLearnOutput,
  revertLearning,
} from './learn';
import type { LearningDeps } from './learn';

const tmpDirs: string[] = [];
const servers: InProcessServer[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('signals (PURE)', () => {
  it('recurringInstructions returns guidance seen ≥ 2 times (normalized), most-frequent first', () => {
    const out = recurringInstructions(['Keep it short', 'keep it  short', 'no emoji']);
    expect(out).toEqual(['Keep it short']); // count 2 (normalized); "no emoji" count 1 dropped
  });

  it('draftVsSentDiff captures what the user changed before sending', () => {
    const diff = draftVsSentDiff('Hi\nThanks\nBest, Jan', 'Hi\nThanks a lot\nBest');
    expect(diff.changed).toBe(true);
    expect(diff.added).toContain('Thanks a lot');
    expect(diff.removed).toContain('Best, Jan');
    expect(diff.unchanged).toBe(1); // "Hi" kept
  });
});

describe('learn job spec + schema (Sonnet, internal — NOT outgoing text)', () => {
  it('buildLearnSpec routes to sonnet and carries the json-schema + learn.md system prompt', () => {
    const spec = buildLearnSpec(
      { type: 'recurring-instruction', instruction: 'keep it short' },
      'contact',
    );
    const argv = buildClaudeArgs(spec);
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(spec.jsonSchema).toBe(LEARN_JSON_SCHEMA);
    expect(spec.systemPromptFile?.endsWith('learn.md')).toBe(true);
  });

  it('learn is DEFERRABLE (not essential) — it must yield to triage when the window is hot', () => {
    expect(isEssentialTask('learn')).toBe(false);
  });

  it('parseLearnOutput validates structured output and throws on an error result', () => {
    const ok: JobResult = baseResult({
      tone_update: 'Prefer short sign-offs.',
      summary: 'Learned: shorter sign-offs.',
    });
    expect(parseLearnOutput(ok)).toEqual(LearnOutputSchema.parse(ok.structuredOutput));
    expect(() => parseLearnOutput({ ...ok, isError: true, structuredOutput: undefined })).toThrow();
  });

  it('appendLesson appends as a new paragraph (and starts an empty file cleanly)', () => {
    expect(appendLesson('', 'Lesson one.')).toBe('Lesson one.');
    expect(appendLesson('Lesson one.', 'Lesson two.')).toBe('Lesson one.\n\nLesson two.');
  });
});

describe('applyLearning + revertLearning — end-to-end through the REAL server', () => {
  function makeDeps(): { deps: LearningDeps; store: ToneStore; server: InProcessServer } {
    const server = startInProcessServer(PROJECT_A);
    servers.push(server);
    const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
    const log = LearningLog.open({ dir: tmpDir('mo-learn-') });
    const runner = new FakeClaudeRunner({
      byKind: {
        learn: {
          structuredOutput: {
            tone_update: 'Prefer short sign-offs.',
            summary: 'Learned: shorter sign-offs.',
          },
          costUsd: 0.01,
          model: 'claude-sonnet-4-6',
        },
      },
    });
    // The real MetadataClient structurally satisfies LearningMetadataClient.
    return { deps: { runner, store, log, metadata: server.client(PROJECT_A) }, store, server };
  }

  it('applies a lesson to the tone file, records it locally + on the server (summary only)', async () => {
    const { deps, store, server } = makeDeps();
    const applied = await applyLearning(
      deps,
      { projectId: PROJECT_A.id, scope: 'contact', path: 'contact/jan@acme.com.md' },
      { type: 'recurring-instruction', instruction: 'keep it short' },
      { now: '2026-06-05T10:00:00Z' },
    );

    expect(applied.summary).toBe('Learned: shorter sign-offs.');
    expect(store.read('contact/jan@acme.com.md')?.content).toBe('Prefer short sign-offs.');

    // Server recorded exactly the changelog summary (a LearningEntry has no body/content field).
    expect(applied.entry.summary).toBe('Learned: shorter sign-offs.');
    expect(applied.entry.reverted_at).toBeNull();
    const onServer = await server.client(PROJECT_A).listLearningEntries();
    expect(onServer.map((e) => e.summary)).toEqual(['Learned: shorter sign-offs.']);

    // Local log carries the before/after snapshots for revert (LOCAL ONLY).
    const record = deps.log.get(applied.entry.id);
    expect(record?.before_content).toBe('');
    expect(record?.after_content).toBe('Prefer short sign-offs.');
  });

  it('reverts a lesson: restores the before-content and flips the server flag (idempotent)', async () => {
    const { deps, store } = makeDeps();
    const applied = await applyLearning(
      deps,
      { projectId: PROJECT_A.id, scope: 'contact', path: 'contact/jan@acme.com.md' },
      { type: 'recurring-instruction', instruction: 'keep it short' },
      { now: '2026-06-05T10:00:00Z' },
    );

    const reverted = await revertLearning(deps, applied.entry.id, { now: '2026-06-05T11:00:00Z' });
    expect(reverted.reverted_at).not.toBeNull();
    expect(store.read('contact/jan@acme.com.md')?.content).toBe(''); // restored before-content
    expect(deps.log.get(applied.entry.id)?.reverted_at).not.toBeNull();

    // Idempotent: re-reverting does not throw.
    await expect(
      revertLearning(deps, applied.entry.id, { now: '2026-06-05T12:00:00Z' }),
    ).resolves.toBeDefined();
  });
});

/** Build a minimal `JobResult` carrying the given structured output (defaults for the rest). */
function baseResult(structuredOutput: unknown): JobResult {
  return {
    structuredOutput,
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
    sessionId: 'fake-learn',
    numTurns: 1,
    durationMs: 0,
  };
}
