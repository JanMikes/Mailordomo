/**
 * Daemon-cycle INTENT coverage (separate test-author, fresh context — PLAN.md §4.4). Expected behavior
 * is derived from PROJECT.md §6 + the golden rules FIRST, then asserted against the orchestrator:
 *
 *   - GOLDEN RULE #1 (sending is ALWAYS manual / the daemon has NO send path): across a FULL cycle that
 *     includes a lapsed-inbound-promise (the one sanctioned overdue-nudge), a HOSTILE transmit-spy filer
 *     records ZERO sends and the daemon only ever DRAFTS. Plus a STRUCTURAL sanity check: `daemon/cycle`
 *     imports nothing under `smtp/`.
 *   - THROTTLE BACKPRESSURE (§4): with the rolling usage window SATURATED (a real entry, real clock —
 *     not just a `throttle:0` shortcut), the deferrable SUMMARIZE is dropped while ESSENTIAL triage +
 *     promise-extraction + the nudge still run; with a FRESH window the summary runs.
 *   - STATE-MACHINE WIRING (§6 "auto-set the obvious"): a new needs-reply inbound opens a task in the
 *     right state; a no-reply-needed ("thanks") on an existing needs-reply task auto-transitions to
 *     `done` (actor-attributed to the daemon); an FYI on a brand-new thread opens `done`.
 *
 * These are ADDITIVE to `cycle.smoke.test.ts`; they harden the matrix the implementer's smoke net seeds.
 * All IO is faked/injected — deterministic, no live `claude`/IMAP/SMTP/network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  CreateDraftMetaRequest,
  CreatePromiseRequest,
  CreateTaskRequest,
  CreateTaskTransitionRequest,
  DraftMeta,
  PromiseRecord,
  Task,
  TaskTransition,
} from '@mailordomo/shared';
import { FakeClaudeRunner } from '../claude/fake-runner';
import { InMemoryUsageWindow, UsageThrottle, type Clock } from '../claude/throttle';
import type { NudgeDraft, NudgeFiledResult } from '../claude/nudge';
import { runDaemonCycle } from './cycle';
import type { DaemonMessage, DaemonMetadataPort, DaemonSource, DraftFiler } from './types';

const NOW = '2026-06-06T09:00:00.000Z';

function triageOut(disposition: 'needs-reply' | 'no-reply-needed' | 'fyi') {
  return {
    structuredOutput: {
      disposition,
      needs_reply: disposition === 'needs-reply',
      importance: 'normal',
      confidence: 'high',
      reason: 'intent',
    },
  };
}

function makeRunner(disposition: 'needs-reply' | 'no-reply-needed' | 'fyi'): FakeClaudeRunner {
  return new FakeClaudeRunner({
    byKind: {
      triage: triageOut(disposition),
      'promise-extraction': { structuredOutput: { promises: [] } },
      summarize: { text: 'A short thread summary.' },
      nudge: { text: 'Hi — just following up on the spec you mentioned. Thanks!' },
    },
  });
}

/** A fakeable {@link DaemonMetadataPort} that records every write + answers the nudge reads. */
class FakeMetadataPort implements DaemonMetadataPort {
  readonly createdTasks: CreateTaskRequest[] = [];
  readonly transitions: { taskId: string; req: CreateTaskTransitionRequest }[] = [];
  readonly createdPromises: CreatePromiseRequest[] = [];
  readonly createdDraftMeta: CreateDraftMetaRequest[] = [];

  constructor(
    private readonly existingPromises: PromiseRecord[] = [],
    private readonly existingDrafts: DraftMeta[] = [],
  ) {}

  createTask(req: CreateTaskRequest): Promise<Task> {
    this.createdTasks.push(req);
    return Promise.resolve({
      id: `task-${this.createdTasks.length}`,
      thread_id: req.thread_id,
      state: req.state ?? 'needs-reply',
      deadline: req.deadline ?? null,
      follow_up_at: req.follow_up_at ?? null,
      importance: req.importance ?? 'normal',
      updated_at: NOW,
    });
  }
  createTransition(taskId: string, req: CreateTaskTransitionRequest): Promise<TaskTransition> {
    this.transitions.push({ taskId, req });
    return Promise.resolve({
      id: `tr-${this.transitions.length}`,
      task_id: taskId,
      from: req.expected_from ?? 'needs-reply',
      to: req.to,
      actor: req.actor,
      at: NOW,
    });
  }
  createPromise(req: CreatePromiseRequest): Promise<PromiseRecord> {
    this.createdPromises.push(req);
    return Promise.resolve({
      id: `p-${this.createdPromises.length}`,
      thread_id: req.thread_id,
      direction: req.direction,
      text: req.text,
      due_at: req.due_at ?? null,
      due_raw: req.due_raw ?? null,
      status: req.status ?? 'open',
      actor: req.actor,
      created_at: NOW,
    });
  }
  listPromises(threadId?: string): Promise<PromiseRecord[]> {
    return Promise.resolve(
      threadId === undefined
        ? this.existingPromises
        : this.existingPromises.filter((p) => p.thread_id === threadId),
    );
  }
  listDraftMeta(threadId?: string): Promise<DraftMeta[]> {
    return Promise.resolve(
      threadId === undefined
        ? this.existingDrafts
        : this.existingDrafts.filter((d) => d.thread_id === threadId),
    );
  }
  createDraftMeta(req: CreateDraftMetaRequest): Promise<DraftMeta> {
    this.createdDraftMeta.push(req);
    return Promise.resolve({
      id: `d-${this.createdDraftMeta.length}`,
      thread_id: req.thread_id,
      version: req.version,
      model: req.model,
      author: req.author,
      at: NOW,
    });
  }
}

/**
 * A HOSTILE filer: it satisfies the save-only {@link DraftFiler} seam but ALSO exposes a `send` spy and
 * a `transmit` spy. If the daemon ever reached for a transport, these would record it. They cannot be
 * reached (no smtp import, no transport reference) — which is exactly what we assert.
 */
class TransmitSpyFiler implements DraftFiler {
  readonly filed: NudgeDraft[] = [];
  sendCalls = 0;
  transmitCalls = 0;
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.filed.push(draft);
    return Promise.resolve({ messageId: `<draft-${this.filed.length}@local>`, filedTo: 'Drafts' });
  }
  /** Tripwires — NOT part of DraftFiler; the cycle has no path to call either. */
  send(): void {
    this.sendCalls += 1;
  }
  transmit(): void {
    this.transmitCalls += 1;
  }
}

/** A fixed clock for the throttle so window math is deterministic (no wall-clock dependency). */
function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function source(...messages: DaemonMessage[]): DaemonSource {
  return { poll: () => Promise.resolve(messages) };
}

function baseMessage(over: Partial<DaemonMessage> = {}): DaemonMessage {
  return {
    threadId: 't1',
    subject: 'Project kickoff',
    sender: 'Petr <petr@acme.com>',
    snippet: 'Can you confirm the timeline?',
    body: 'Hi, can you confirm the timeline by Friday?',
    receivedIso: NOW,
    task: { id: null, state: 'needs-reply', lastActivityIso: NOW },
    threadMessages: [],
    ...over,
  };
}

const lapsedInbound: PromiseRecord = {
  id: 'pr1',
  thread_id: 't1',
  direction: 'awaiting-them',
  text: 'Petr will send the API spec',
  due_at: '2026-06-01T09:00:00.000Z', // strictly before NOW ⇒ lapsed
  due_raw: 'by last Monday',
  status: 'overdue',
  actor: 'claude',
  created_at: '2026-05-20T09:00:00.000Z',
};

describe('runDaemonCycle — Golden rule #1: the daemon NEVER sends (intent)', () => {
  it('runs a FULL cycle incl. the overdue nudge and transmits NOTHING (hostile transmit-spy)', async () => {
    // A waiting thread WITH a lapsed inbound promise ⇒ the sanctioned nudge fires. The runner also
    // answers triage/extract/summarize, so this is a complete pass over the whole pipeline.
    const metadata = new FakeMetadataPort([lapsedInbound], []);
    const filer = new TransmitSpyFiler();

    const result = await runDaemonCycle({
      source: source(
        baseMessage({
          task: { id: 'task-1', state: 'waiting', lastActivityIso: NOW },
          threadMessages: [{ sender: 'Petr', body: 'the original ask' }],
        }),
      ),
      runner: makeRunner('fyi'),
      throttle: new UsageThrottle(),
      metadata,
      filer,
      now: () => NOW,
      newId: () => 'id',
    });

    // The daemon DRAFTED the nudge exactly once, addressed to the party who owes me…
    expect(filer.filed).toHaveLength(1);
    expect(filer.filed[0]?.to).toBe('Petr <petr@acme.com>');
    expect(result.nudgesDrafted).toBe(1);
    // …and it NEVER transmitted, by any verb. There is no transport on this path at all.
    expect(filer.sendCalls).toBe(0);
    expect(filer.transmitCalls).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('STRUCTURAL: the daemon cycle source imports nothing under `smtp/`', () => {
    // Static-source sanity backing the behavioral proof above (the ESLint import-boundary guard, tested
    // separately in `sendguard.test.ts`, enforces this — here we read the actual file as belt-and-braces).
    const cyclePath = fileURLToPath(new URL('./cycle.ts', import.meta.url));
    const src = readFileSync(cyclePath, 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*smtp[^'"]*['"]/);
    expect(src).not.toMatch(/import\(\s*['"][^'"]*smtp[^'"]*['"]\s*\)/);
  });
});

describe('runDaemonCycle — throttle backpressure with a SATURATED rolling window (intent)', () => {
  it('drops the deferrable summary but still runs essential triage/extract/nudge', async () => {
    // Saturate the window the HONEST way: pre-load a usage entry above the throttle, fixed clock so the
    // entry is in-window. This proves the gate (not a `throttle:0` shortcut) drives the backpressure.
    const store = new InMemoryUsageWindow();
    store.add(new Date(NOW).getTime(), 5); // 5 >> throttle 2.5 ⇒ over-throttle
    const throttle = new UsageThrottle({ throttle: 2.5, store, clock: fixedClock(NOW) });
    expect(throttle.usageInWindow()).toBe(5); // window is genuinely saturated

    const metadata = new FakeMetadataPort([lapsedInbound], []);
    const runner = makeRunner('needs-reply');
    const filer = new TransmitSpyFiler();
    const result = await runDaemonCycle({
      source: source(
        baseMessage({
          task: { id: 'task-1', state: 'waiting', lastActivityIso: NOW },
          threadMessages: [{ sender: 'Petr', body: 'hello' }],
        }),
      ),
      runner,
      throttle,
      metadata,
      filer,
      now: () => NOW,
      newId: () => 'id',
    });

    const kinds = runner.calls.map((c) => c.taskKind);
    expect(kinds).toContain('triage'); // essential proceeds over-throttle
    expect(kinds).toContain('promise-extraction'); // essential proceeds over-throttle
    expect(kinds).toContain('nudge'); // the sanctioned nudge is essential → proceeds
    expect(kinds).not.toContain('summarize'); // deferrable summary backpressured
    expect(result.summarized).toBe(0);
    expect(result.deferred).toBe(1);
    expect(filer.filed).toHaveLength(1); // the nudge still drafted (and still never sent)
    expect(filer.sendCalls).toBe(0);
  });

  it('with a FRESH (empty) window the same deferrable summary runs', async () => {
    const store = new InMemoryUsageWindow(); // empty ⇒ within throttle
    const throttle = new UsageThrottle({ throttle: 2.5, store, clock: fixedClock(NOW) });
    const summaries: { threadId: string; summary: string }[] = [];
    const result = await runDaemonCycle({
      source: source(baseMessage({ threadMessages: [{ sender: 'Petr', body: 'hello' }] })),
      runner: makeRunner('needs-reply'),
      throttle,
      metadata: new FakeMetadataPort(),
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
      onSummary: (threadId, summary) => summaries.push({ threadId, summary }),
    });
    expect(result.summarized).toBe(1);
    expect(result.deferred).toBe(0);
    expect(summaries).toEqual([{ threadId: 't1', summary: 'A short thread summary.' }]);
  });
});

describe('runDaemonCycle — state-machine wiring (§6 auto-set the obvious) (intent)', () => {
  it('a NEW needs-reply inbound opens a task in `needs-reply` (no transition; nothing to move from)', async () => {
    const metadata = new FakeMetadataPort();
    const result = await runDaemonCycle({
      source: source(baseMessage()),
      runner: makeRunner('needs-reply'),
      throttle: new UsageThrottle(),
      metadata,
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
    });
    expect(metadata.createdTasks).toEqual([{ thread_id: 't1', state: 'needs-reply' }]);
    expect(metadata.transitions).toHaveLength(0);
    expect(result.tasksCreated).toBe(1);
  });

  it('a "thanks" (no-reply-needed) on an EXISTING needs-reply task auto-transitions to `done`, attributed to the daemon', async () => {
    const metadata = new FakeMetadataPort();
    await runDaemonCycle({
      source: source(
        baseMessage({ task: { id: 'task-7', state: 'needs-reply', lastActivityIso: NOW } }),
      ),
      runner: makeRunner('no-reply-needed'),
      throttle: new UsageThrottle(),
      metadata,
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
    });
    expect(metadata.createdTasks).toHaveLength(0);
    expect(metadata.transitions).toEqual([
      { taskId: 'task-7', req: { to: 'done', actor: 'claude', expected_from: 'needs-reply' } },
    ]);
  });

  it('an FYI on a BRAND-NEW thread opens the task in `done` (nothing owed)', async () => {
    const metadata = new FakeMetadataPort();
    await runDaemonCycle({
      source: source(baseMessage()),
      runner: makeRunner('fyi'),
      throttle: new UsageThrottle(),
      metadata,
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
    });
    expect(metadata.createdTasks).toEqual([{ thread_id: 't1', state: 'done' }]);
  });
});
