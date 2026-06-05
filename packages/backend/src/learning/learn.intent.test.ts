/**
 * INTENT-DERIVED suite for the silent-learning ORCHESTRATOR (PROJECT.md §6: "Continuous learning is
 * silent + logged + revertable … writing a changelog the user can review and revert"; Golden rule #1
 * "Sending email is ALWAYS manual"; §4/Golden rule #6 model routing). Written from the SPEC, additive
 * to the implementer's `learning.smoke.test.ts`. Uses the FAKE runner + the REAL in-process server.
 *
 * Load-bearing invariants pinned:
 *  - APPLY writes the tone update AND records a before/after snapshot LOCALLY; the server gets the
 *    one-line SUMMARY ONLY (a `LearningEntry` carries no content/body/before/after field).
 *  - REVERT restores the EXACT before-content, sets `reverted_at`, and is IDEMPOTENT (no second tone
 *    write on a re-revert — pinned by a write-count spy).
 *  - GUARD: a full apply→revert cycle, driven against HOSTILE collaborators that expose transmit
 *    spies, NEVER invokes any of them (0 sends) and only ever edits the TARGET tone file — learning
 *    can neither send nor mutate a "sent" message.
 *  - ROUTING: `learn` → sonnet, is NOT outgoing text, and is DEFERRABLE (yields to essential triage).
 *
 * MUTATION CHECK (pins "revert restores before"): change `revertLearning` to write `after_content`
 * (or skip the restore) and `restores the EXACT before-content` FAILS. Drop the `reverted_at === null`
 * guard and the write-count idempotency assertion (`exactly 2 tone writes`) FAILS. Verified by reasoning.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelForTask, OUTGOING_TEXT_TASK_KINDS } from '@mailordomo/shared';
import { FakeClaudeRunner, isEssentialTask } from '../claude';
import type { ClaudeRunner, JobSpec } from '../claude';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { ToneStore } from '../tone/store';
import { LearningLog } from './log';
import { applyLearning, revertLearning } from './learn';
import type { LearnSignal, LearnTarget, LearningDeps, LearningMetadataClient } from './learn';

const tmpDirs: string[] = [];
const servers: InProcessServer[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T1 = '2026-06-05T10:00:00.000Z';
const T2 = '2026-06-05T11:00:00.000Z';
const T3 = '2026-06-05T12:00:00.000Z';

const TARGET: LearnTarget = {
  projectId: PROJECT_A.id,
  scope: 'contact',
  path: 'contact/jan@acme.com.md',
};
const SIGNAL: LearnSignal = { type: 'recurring-instruction', instruction: 'keep it short' };
const LESSON = 'Prefer a brief one-line sign-off; the user trims long closings.';
const SUMMARY = 'Learned: shorter sign-offs for this contact.';

/** A fake runner that answers the `learn` job with a fixed `{tone_update, summary}` (no live call). */
function learnRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner({
    byKind: {
      learn: {
        structuredOutput: { tone_update: LESSON, summary: SUMMARY },
        costUsd: 0.02,
        model: 'claude-sonnet-4-6',
      },
    },
  });
}

interface Harness {
  deps: LearningDeps;
  store: ToneStore;
  log: LearningLog;
  server: InProcessServer;
}

function makeHarness(): Harness {
  const server = startInProcessServer(PROJECT_A);
  servers.push(server);
  const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
  const log = LearningLog.open({ dir: tmpDir('mo-learn-') });
  const deps: LearningDeps = {
    runner: learnRunner(),
    store,
    log,
    metadata: server.client(PROJECT_A),
  };
  return { deps, store, log, server };
}

/* -------------------------------------------------------------------------- */
/* Routing / throttle                                                          */
/* -------------------------------------------------------------------------- */

describe('routing + throttle for the `learn` task kind (PROJECT.md §4 / Golden rule #6)', () => {
  it('routes to SONNET — internal memory analysis, never an Opus outgoing-text job', () => {
    expect(modelForTask('learn')).toBe('sonnet');
  });

  it('is NOT in OUTGOING_TEXT_TASK_KINDS (it produces guidance, not a message a recipient reads)', () => {
    expect([...OUTGOING_TEXT_TASK_KINDS]).not.toContain('learn');
  });

  it('is DEFERRABLE so it yields to essential triage when the subscription window is hot', () => {
    expect(isEssentialTask('learn')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Apply — tone update + local snapshot + server summary-only                  */
/* -------------------------------------------------------------------------- */

describe('applyLearning — appends the lesson, records summary-only on the server (PROJECT.md §6)', () => {
  it('appends the tone_update and captures the before/after snapshot LOCALLY', async () => {
    const { deps, store, log } = makeHarness();
    // Pre-seed a non-empty tone file so the "before" snapshot is meaningful (not just empty).
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: 'Existing guidance.',
      updated_by: 'jan',
      updated_at: T1,
    });

    const applied = await applyLearning(deps, TARGET, SIGNAL, { now: T2 });

    // The lesson is APPENDED as a new paragraph (existing guidance preserved).
    expect(store.read(TARGET.path)?.content).toBe(`Existing guidance.\n\n${LESSON}`);
    expect(applied.toneUpdate).toBe(LESSON);
    expect(applied.model).toBe('claude-sonnet-4-6');
    expect(applied.costUsd).toBe(0.02); // notional usage surfaced for the throttle, not a real charge

    // Local log holds BOTH snapshots needed to revert (LOCAL ONLY).
    const record = log.get(applied.entry.id);
    expect(record?.before_content).toBe('Existing guidance.');
    expect(record?.after_content).toBe(`Existing guidance.\n\n${LESSON}`);
  });

  it('the SERVER changelog entry carries ONLY the summary — no content/body/before/after field', async () => {
    const { deps, server } = makeHarness();
    const applied = await applyLearning(deps, TARGET, SIGNAL, { now: T2 });

    expect(applied.entry.summary).toBe(SUMMARY);
    expect(applied.entry.reverted_at).toBeNull();
    // The LearningEntry shape is the privacy boundary: only these keys, never a snapshot/body.
    expect(Object.keys(applied.entry).sort()).toEqual([
      'applied_at',
      'id',
      'project_id',
      'reverted_at',
      'scope',
      'summary',
    ]);

    // Round-trips through the REAL server with exactly the summary.
    const onServer = await server.client(PROJECT_A).listLearningEntries();
    expect(onServer.map((e) => e.summary)).toEqual([SUMMARY]);
  });
});

/* -------------------------------------------------------------------------- */
/* Revert — restores the exact before-content, idempotent                      */
/* -------------------------------------------------------------------------- */

describe('revertLearning — restores the EXACT before-content, idempotently (PROJECT.md §6)', () => {
  it('restores the before-content byte-for-byte and flips the server flag', async () => {
    const { deps, store, log } = makeHarness();
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: 'Existing guidance.',
      updated_by: 'jan',
      updated_at: T1,
    });
    const applied = await applyLearning(deps, TARGET, SIGNAL, { now: T2 });
    expect(store.read(TARGET.path)?.content).toBe(`Existing guidance.\n\n${LESSON}`);

    const reverted = await revertLearning(deps, applied.entry.id, { now: T3 });

    // EXACT before-content restored — not the after-content, not a merge.
    expect(store.read(TARGET.path)?.content).toBe('Existing guidance.');
    expect(reverted.reverted_at).not.toBeNull();
    expect(log.get(applied.entry.id)?.reverted_at).not.toBeNull();
  });

  it('is IDEMPOTENT: a re-revert does not throw and performs NO second tone write', async () => {
    const { deps, store } = makeHarness();
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: 'Existing guidance.',
      updated_by: 'jan',
      updated_at: T1,
    });
    // Spy AFTER the pre-seed so the counter only sees apply + revert writes.
    const writeSpy = vi.spyOn(store, 'write');

    const applied = await applyLearning(deps, TARGET, SIGNAL, { now: T2 }); // write #1 (apply)
    await revertLearning(deps, applied.entry.id, { now: T3 }); // write #2 (restore before)
    await expect(
      revertLearning(deps, applied.entry.id, { now: '2026-06-05T13:00:00.000Z' }),
    ).resolves.toBeDefined(); // re-revert: NO write

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(store.read(TARGET.path)?.content).toBe('Existing guidance.'); // still the before-content
  });

  it('reverting an unknown id throws (cannot restore a snapshot it never recorded)', async () => {
    const { deps } = makeHarness();
    await expect(revertLearning(deps, 'no-such-id', { now: T2 })).rejects.toThrow(/unknown/);
  });
});

/* -------------------------------------------------------------------------- */
/* GUARD — learning never sends, never edits a sent message (Golden rule #1)   */
/* -------------------------------------------------------------------------- */

/** A fresh set of poisoned transmit spies; if learning ever reached for one, it would be recorded. */
function transmitSpies() {
  return {
    send: vi.fn(),
    sendReply: vi.fn(),
    sendMail: vi.fn(),
    sendMessage: vi.fn(),
    transmit: vi.fn(),
    deliver: vi.fn(),
  };
}

describe('GUARD — a full learning cycle can never send (Golden rule #1, behavioral)', () => {
  it('drives apply→revert against HOSTILE collaborators yet invokes NO transmit spy (0 sends)', async () => {
    const server = startInProcessServer(PROJECT_A);
    servers.push(server);
    const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
    const log = LearningLog.open({ dir: tmpDir('mo-learn-') });
    const realRunner = learnRunner();
    const realClient = server.client(PROJECT_A);

    // The runner and the metadata client are the only injected collaborators that touch the outside
    // world. Wrap each so it carries a transmit spy ALONGSIDE its real method — the Phase-5 hostile
    // pattern: the orchestrator must never reach for the transmit verb.
    const runnerSpies = transmitSpies();
    const hostileRunner = {
      run: (spec: JobSpec) => realRunner.run(spec),
      ...runnerSpies,
    } as unknown as ClaudeRunner;

    const metaSpies = transmitSpies();
    const hostileMetadata = {
      createLearningEntry: (req: Parameters<LearningMetadataClient['createLearningEntry']>[0]) =>
        realClient.createLearningEntry(req),
      revertLearningEntry: (id: string) => realClient.revertLearningEntry(id),
      ...metaSpies,
    } as unknown as LearningMetadataClient;

    const deps: LearningDeps = { runner: hostileRunner, store, log, metadata: hostileMetadata };
    const writeSpy = vi.spyOn(store, 'write');

    // A REAL cycle (so "0 sends" is not vacuous): apply mutates the tone file, revert undoes it.
    const applied = await applyLearning(deps, TARGET, SIGNAL, { now: T1 });
    expect(store.read(TARGET.path)?.content).toBe(LESSON);
    await revertLearning(deps, applied.entry.id, { now: T2 });
    expect(store.read(TARGET.path)?.content).toBe(''); // empty before-content restored

    // Not one transmit method on any collaborator was ever called.
    for (const spy of [...Object.values(runnerSpies), ...Object.values(metaSpies)]) {
      expect(spy).toHaveBeenCalledTimes(0);
    }

    // Learning only ever edited the TARGET tone file — never anything resembling a "sent message".
    expect(writeSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of writeSpy.mock.calls) {
      expect(input.path).toBe(TARGET.path);
    }
  });

  it('LearningDeps wires NO transmit/message collaborator at all (structural)', () => {
    const { deps } = makeHarness();
    // Exactly these four collaborators — no `smtp`/`sender`/`mailer`/message store could be reached.
    expect(Object.keys(deps).sort()).toEqual(['log', 'metadata', 'runner', 'store']);
  });
});
