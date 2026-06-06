/**
 * Daemon-cycle SMOKE coverage (PLAN.md D34) — drives the orchestrator entirely through FAKES (no
 * IMAP, no metadata server, no `claude`). Asserts the load-bearing wiring + the golden-rule #1 safety:
 *   - triage → state machine → metadata (new thread creates a task; an auto edge records a transition);
 *   - usage-throttle BACKPRESSURE (deferrable summary skipped over-throttle; essential triage proceeds);
 *   - the sanctioned overdue-nudge DRAFTS, never sends (a hostile transmit-spy filer is never asked to
 *     transmit; the cycle has no transport reference at all).
 * The separate test-author hardens the matrix; this is the implementer's smoke net.
 */
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
import { UsageThrottle } from '../claude/throttle';
import type { NudgeDraft, NudgeFiledResult } from '../claude/nudge';
import { runDaemonCycle } from './cycle';
import type { DaemonMessage, DaemonMetadataPort, DaemonSource, DraftFiler } from './types';

const NOW = '2026-06-06T09:00:00.000Z';

/** A triage `structured_output` for a given disposition (the rest of the decision is filler). */
function triageOut(disposition: 'needs-reply' | 'no-reply-needed' | 'fyi') {
  return {
    structuredOutput: {
      disposition,
      needs_reply: disposition === 'needs-reply',
      importance: 'normal',
      confidence: 'high',
      reason: 'smoke',
    },
  };
}

/** A runner that answers triage + extraction + summary + nudge with canned, schema-valid output. */
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
 * A HOSTILE filer: implements the saveDraft-only {@link DraftFiler} seam BUT also exposes a `send`
 * spy. If the daemon ever transmitted, it would have to reach a transport — it cannot (no smtp import,
 * no transport reference). We assert `sendCalls === 0` AND that a draft WAS filed.
 */
class TransmitSpyFiler implements DraftFiler {
  readonly filed: NudgeDraft[] = [];
  sendCalls = 0;
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.filed.push(draft);
    return Promise.resolve({ messageId: `<draft-${this.filed.length}@local>`, filedTo: 'Drafts' });
  }
  /** NOT part of DraftFiler — a tripwire. The cycle has no path to call this. */
  send(): void {
    this.sendCalls += 1;
  }
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

describe('runDaemonCycle (smoke)', () => {
  it('triage of a NEW thread creates a task in the inferred state (needs-reply)', async () => {
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
    expect(result.processed).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('triage of an EXISTING needs-reply task auto-transitions to done on a no-reply-needed disposition', async () => {
    const metadata = new FakeMetadataPort();
    await runDaemonCycle({
      source: source(
        baseMessage({ task: { id: 'task-1', state: 'needs-reply', lastActivityIso: NOW } }),
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
      { taskId: 'task-1', req: { to: 'done', actor: 'claude', expected_from: 'needs-reply' } },
    ]);
  });

  it('THROTTLE BACKPRESSURE: deferrable summary is skipped over-throttle; essential triage proceeds', async () => {
    const metadata = new FakeMetadataPort();
    const runner = makeRunner('needs-reply');
    const result = await runDaemonCycle({
      source: source(baseMessage({ threadMessages: [{ sender: 'Petr', body: 'hello' }] })),
      runner,
      throttle: new UsageThrottle({ throttle: 0 }), // fully-closed gate ⇒ always over-throttle
      metadata,
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
    });

    const kinds = runner.calls.map((c) => c.taskKind);
    expect(kinds).toContain('triage'); // essential proceeds
    expect(kinds).toContain('promise-extraction'); // essential proceeds
    expect(kinds).not.toContain('summarize'); // deferrable backpressured
    expect(result.summarized).toBe(0);
    expect(result.deferred).toBe(1);
    expect(metadata.createdTasks).toHaveLength(1); // triage still wrote state
  });

  it('within-throttle: the deferrable summary runs and reaches the summary sink', async () => {
    const metadata = new FakeMetadataPort();
    const summaries: { threadId: string; summary: string }[] = [];
    const result = await runDaemonCycle({
      source: source(baseMessage({ threadMessages: [{ sender: 'Petr', body: 'hello' }] })),
      runner: makeRunner('needs-reply'),
      throttle: new UsageThrottle(), // default 2.5 ⇒ within throttle
      metadata,
      filer: new TransmitSpyFiler(),
      now: () => NOW,
      newId: () => 'id',
      onSummary: (threadId, summary) => summaries.push({ threadId, summary }),
    });
    expect(result.summarized).toBe(1);
    expect(summaries).toEqual([{ threadId: 't1', summary: 'A short thread summary.' }]);
  });

  it('the overdue NUDGE drafts a reply and NEVER sends (transmit-spy filer)', async () => {
    const overdue: PromiseRecord = {
      id: 'pr1',
      thread_id: 't1',
      direction: 'awaiting-them',
      text: 'Petr will send the API spec',
      due_at: '2026-06-01T09:00:00.000Z', // before NOW ⇒ lapsed
      due_raw: 'by last Monday',
      status: 'overdue',
      actor: 'claude',
      created_at: '2026-05-20T09:00:00.000Z',
    };
    const metadata = new FakeMetadataPort([overdue], []);
    const filer = new TransmitSpyFiler();

    const result = await runDaemonCycle({
      source: source(
        baseMessage({ task: { id: 'task-1', state: 'waiting', lastActivityIso: NOW } }),
      ),
      runner: makeRunner('fyi'),
      throttle: new UsageThrottle(),
      metadata,
      filer,
      now: () => NOW,
      newId: () => 'id',
    });

    // A DRAFT was filed, exactly once, addressed to the party who owes me — and NOTHING was transmitted.
    expect(filer.filed).toHaveLength(1);
    expect(filer.filed[0]?.to).toBe('Petr <petr@acme.com>');
    expect(filer.filed[0]?.body).toContain('following up');
    expect(filer.sendCalls).toBe(0);
    // Body-free draft metadata recorded (Opus alias), so Today flags hasDraftReady + the next cycle dedups.
    expect(metadata.createdDraftMeta).toEqual([
      { thread_id: 't1', version: 1, model: 'opus', author: 'claude' },
    ]);
    expect(result.nudgesDrafted).toBe(1);
  });

  it('the nudge is DEDUPED: a thread that already has a draft is not nudged again', async () => {
    const overdue: PromiseRecord = {
      id: 'pr1',
      thread_id: 't1',
      direction: 'awaiting-them',
      text: 'Petr will send the API spec',
      due_at: '2026-06-01T09:00:00.000Z',
      due_raw: 'last Monday',
      status: 'overdue',
      actor: 'claude',
      created_at: '2026-05-20T09:00:00.000Z',
    };
    const existingDraft: DraftMeta = {
      id: 'd0',
      thread_id: 't1',
      version: 1,
      model: 'opus',
      author: 'claude',
      at: '2026-06-05T09:00:00.000Z',
    };
    const metadata = new FakeMetadataPort([overdue], [existingDraft]);
    const filer = new TransmitSpyFiler();
    const result = await runDaemonCycle({
      source: source(
        baseMessage({ task: { id: 'task-1', state: 'waiting', lastActivityIso: NOW } }),
      ),
      runner: makeRunner('fyi'),
      throttle: new UsageThrottle(),
      metadata,
      filer,
      now: () => NOW,
      newId: () => 'id',
    });
    expect(filer.filed).toHaveLength(0);
    expect(result.nudgesDrafted).toBe(0);
  });
});
