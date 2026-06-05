/**
 * INTENT (separate test-author) — the pure `assembleTodayView` assembler (PROJECT.md §5/§7/§8/§11,
 * PLAN.md D26/D29). ADDITIVE to `today-view.smoke.test.ts`. Everything is hand-crafted with a fixed
 * injected `nowIso`, so the assembler is exercised deterministically.
 *
 * It pins, from the SPEC: the exact 3-way metric counts (total / open / overdue per direction), that
 * done + remaining == total tasks and `doNext` excludes done, the D26 ranked order (my-promise >
 * they-asked > importance, and awaiting-them confers nothing), the privacy surface (cards carry
 * subject/snippet/sender but NO body), the draft-ready flag, that `staleReason`/`ageMs` faithfully
 * delegate to `detectStale`, the urgency labels, and the do-next cap.
 */
import { describe, expect, it } from 'vitest';
import type { DraftMeta, PromiseRecord, Task, Thread } from '@mailordomo/shared';
import { DEFAULT_APP_SETTINGS, TodayReadModelSchema } from '@mailordomo/shared';
import { detectStale } from '../engines';
import { assembleTodayView, MAX_DO_NEXT_CARDS } from './today-view';

const NOW = '2026-06-05T12:00:00.000Z';
const H1_AGO = '2026-06-05T11:00:00.000Z'; // now − 1h
const D3_AGO = '2026-06-02T12:00:00.000Z'; // now − 3d
const D5_AGO = '2026-05-31T12:00:00.000Z'; // now − 5d
const OVERDUE = '2026-06-01T00:00:00.000Z'; // past
const SOON = '2026-06-06T12:00:00.000Z'; // now + 24h (within the 48h due-soon window)
const DATED = '2026-06-20T00:00:00.000Z'; // future, > 48h

const STALE_THRESHOLDS = {
  waitingStaleDays: DEFAULT_APP_SETTINGS.waitingStaleDays,
  needsReplyStaleDays: DEFAULT_APP_SETTINGS.needsReplyStaleDays,
};

function thread(id: string, lastMessageAt: string | null): Thread {
  return {
    id,
    project_id: 'proj',
    mailbox_address: 'jan@acme.com',
    root_message_id: `<${id}@acme.com>`,
    subject: `Subject ${id}`,
    snippet: `snippet for ${id}`,
    sender: `Petr <petr+${id}@acme.com>`,
    last_message_at: lastMessageAt,
    updated_at: NOW,
  };
}

function task(over: Partial<Task> & { id: string; thread_id: string }): Task {
  return {
    state: 'needs-reply',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
    ...over,
  };
}

function promise(over: Partial<PromiseRecord> & { id: string; thread_id: string }): PromiseRecord {
  return {
    direction: 'my-promise',
    text: 'a promise',
    due_at: null,
    due_raw: null,
    status: 'open',
    actor: 'me',
    created_at: NOW,
    ...over,
  };
}

// th-mine: a stale needs-reply with an overdue my-promise (the top tier).
// th-owe : a fresh needs-reply with a due-soon they-asked + a ready draft.
// th-vip : a stale waiting, no commitments, HIGH importance.
// th-await: a fresh needs-reply with only awaiting-them work (confers nothing).
const threads: Thread[] = [
  thread('th-mine', D3_AGO),
  thread('th-owe', H1_AGO),
  thread('th-vip', D5_AGO),
  thread('th-await', H1_AGO),
];

const tasks: Task[] = [
  task({ id: 'task-mine', thread_id: 'th-mine', state: 'needs-reply' }),
  task({ id: 'task-owe', thread_id: 'th-owe', state: 'needs-reply' }),
  task({ id: 'task-vip', thread_id: 'th-vip', state: 'waiting', importance: 'high' }),
  task({ id: 'task-await', thread_id: 'th-await', state: 'needs-reply' }),
  // A DONE task whose thread is not cached: counts as done, yields no card.
  task({ id: 'task-done', thread_id: 'th-doneonly', state: 'done' }),
  // A non-done task whose thread is NOT cached: counts as remaining but cannot render a card.
  task({ id: 'task-ghost', thread_id: 'th-ghost', state: 'needs-reply' }),
];

const promises: PromiseRecord[] = [
  // my-promise: one overdue (open/actionable) + one fulfilled (total only).
  promise({
    id: 'pm1',
    thread_id: 'th-mine',
    direction: 'my-promise',
    status: 'overdue',
    due_at: OVERDUE,
  }),
  promise({
    id: 'pm2',
    thread_id: 'th-mine',
    direction: 'my-promise',
    status: 'fulfilled',
    due_at: OVERDUE,
  }),
  // they-asked: one open due-soon + one cancelled (total only).
  promise({
    id: 'pt1',
    thread_id: 'th-owe',
    direction: 'they-asked',
    status: 'open',
    due_at: SOON,
  }),
  promise({
    id: 'pt2',
    thread_id: 'th-owe',
    direction: 'they-asked',
    status: 'cancelled',
    due_at: null,
  }),
  // awaiting-them: one open undated + one overdue.
  promise({
    id: 'pa1',
    thread_id: 'th-await',
    direction: 'awaiting-them',
    status: 'open',
    due_at: null,
  }),
  promise({
    id: 'pa2',
    thread_id: 'th-await',
    direction: 'awaiting-them',
    status: 'overdue',
    due_at: OVERDUE,
  }),
];

const draftMeta: DraftMeta[] = [
  { id: 'd1', thread_id: 'th-owe', version: 1, model: 'opus', author: 'claude', at: NOW },
];

const model = assembleTodayView(
  { projectId: 'proj', tasks, threads, promises, draftMeta, settings: DEFAULT_APP_SETTINGS },
  NOW,
);

describe('assembleTodayView — 3-way promise metrics (PROJECT.md §7)', () => {
  it('counts total (any status), openCount (open|overdue), overdueCount (overdue) per direction', () => {
    expect(model.promiseMetrics.myPromises).toEqual({ total: 2, openCount: 1, overdueCount: 1 });
    expect(model.promiseMetrics.theyAsked).toEqual({ total: 2, openCount: 1, overdueCount: 0 });
    expect(model.promiseMetrics.awaitingThem).toEqual({ total: 2, openCount: 2, overdueCount: 1 });
  });

  it('maintains overdueCount <= openCount <= total in every direction', () => {
    for (const m of Object.values(model.promiseMetrics)) {
      expect(m.overdueCount).toBeLessThanOrEqual(m.openCount);
      expect(m.openCount).toBeLessThanOrEqual(m.total);
    }
  });
});

describe('assembleTodayView — task counts + do-next membership (PROJECT.md §11)', () => {
  it('done + remaining == total tasks', () => {
    expect(model.taskCounts).toEqual({ remaining: 5, done: 1 });
    expect(model.taskCounts.done + model.taskCounts.remaining).toBe(tasks.length);
  });

  it('doNext EXCLUDES done tasks and tasks with no cached thread', () => {
    const ids = model.doNext.map((c) => c.threadId);
    expect(ids).not.toContain('th-doneonly'); // done
    expect(ids).not.toContain('th-ghost'); // remaining, but no cached thread → no card
    expect(model.doNext.every((c) => c.state !== 'done')).toBe(true);
    expect(ids).toEqual(['th-mine', 'th-owe', 'th-vip', 'th-await']);
  });
});

describe('assembleTodayView — do-next order is the D26 ranker (PROJECT.md §8 + D26)', () => {
  it('orders my-promise > they-asked > importance, and awaiting-them confers no rank', () => {
    // th-mine (my-promise) leads; th-owe (they-asked) next; th-vip (no commitment, HIGH) beats
    // th-await (no commitment, normal — its awaiting-them work does NOT lift it).
    expect(model.doNext.map((c) => c.threadId)).toEqual([
      'th-mine',
      'th-owe',
      'th-vip',
      'th-await',
    ]);
  });

  it('an awaiting-them-only thread carries NO commitment urgency (chase, not deliver)', () => {
    const awaitCard = model.doNext.find((c) => c.threadId === 'th-await');
    expect(awaitCard?.myPromiseUrgency).toBeNull();
    expect(awaitCard?.theyAskedUrgency).toBeNull();
    expect(awaitCard?.promiseDirections).toEqual(['awaiting-them']);
  });
});

describe('assembleTodayView — privacy surface (Golden rule #3): body-free cards', () => {
  it('every card carries subject/snippet/sender and NO body/draftBody/content field', () => {
    for (const card of model.doNext) {
      expect(typeof card.subject).toBe('string');
      expect(typeof card.snippet).toBe('string');
      expect(typeof card.sender).toBe('string');
      // Belt-and-suspenders beyond the strict type: assert the keys are physically absent at runtime.
      expect('body' in card).toBe(false);
      expect('draftBody' in card).toBe(false);
      expect('content' in card).toBe(false);
    }
  });

  it('the whole model is a strict, valid, body-free TodayReadModel', () => {
    expect(() => TodayReadModelSchema.parse(model)).not.toThrow();
    expect(JSON.stringify(model)).not.toContain('"body"');
    expect(JSON.stringify(model)).not.toContain('"draftBody"');
  });
});

describe('assembleTodayView — per-card flags, urgency, and stale delegation', () => {
  it('hasDraftReady is true exactly for the thread with draft metadata', () => {
    const byId = new Map(model.doNext.map((c) => [c.threadId, c] as const));
    expect(byId.get('th-owe')?.hasDraftReady).toBe(true); // d1 exists on th-owe
    expect(byId.get('th-mine')?.hasDraftReady).toBe(false);
    expect(byId.get('th-vip')?.hasDraftReady).toBe(false);
    expect(byId.get('th-await')?.hasDraftReady).toBe(false);
  });

  it('urgency labels match the actionable promise deadlines (overdue / due-soon / none)', () => {
    const byId = new Map(model.doNext.map((c) => [c.threadId, c] as const));
    expect(byId.get('th-mine')?.myPromiseUrgency).toBe('overdue'); // pm1 due in the past
    expect(byId.get('th-mine')?.theyAskedUrgency).toBeNull();
    expect(byId.get('th-owe')?.theyAskedUrgency).toBe('due-soon'); // pt1 within 48h
    expect(byId.get('th-owe')?.myPromiseUrgency).toBeNull();
  });

  it('a future-but-far they-asked deadline reads as `dated` (not due-soon)', () => {
    const single = assembleTodayView(
      {
        projectId: 'proj',
        threads: [thread('th-x', H1_AGO)],
        tasks: [task({ id: 't-x', thread_id: 'th-x', state: 'needs-reply' })],
        promises: [
          promise({
            id: 'px',
            thread_id: 'th-x',
            direction: 'they-asked',
            status: 'open',
            due_at: DATED,
          }),
        ],
        draftMeta: [],
        settings: DEFAULT_APP_SETTINGS,
      },
      NOW,
    );
    expect(single.doNext[0]?.theyAskedUrgency).toBe('dated');
  });

  it('staleReason + ageMs delegate faithfully to detectStale for every card', () => {
    const threadById = new Map(threads.map((t) => [t.id, t] as const));
    const taskByThread = new Map(tasks.map((t) => [t.thread_id, t] as const));
    for (const card of model.doNext) {
      const th = threadById.get(card.threadId);
      const tk = taskByThread.get(card.threadId);
      if (th === undefined || tk === undefined)
        throw new Error(`missing seed for ${card.threadId}`);
      const verdict = detectStale(
        {
          state: tk.state,
          lastActivityIso: th.last_message_at,
          followUpAtIso: tk.follow_up_at,
          deadlineIso: tk.deadline,
        },
        NOW,
        STALE_THRESHOLDS,
      );
      expect(card.staleReason).toBe(verdict.reason ?? null);
      expect(card.ageMs).toBe(verdict.ageMs);
    }
  });

  it('the concrete stale verdicts: stale where overdue/silent, clear where fresh', () => {
    const byId = new Map(model.doNext.map((c) => [c.threadId, c] as const));
    expect(byId.get('th-mine')?.staleReason).toBe('unanswered-too-long'); // needs-reply, 3d ≥ 2d
    expect(byId.get('th-vip')?.staleReason).toBe('awaiting-reply-too-long'); // waiting, 5d ≥ 3d
    expect(byId.get('th-owe')?.staleReason).toBeNull(); // needs-reply, 1h < 2d
    expect(byId.get('th-await')?.staleReason).toBeNull(); // needs-reply, 1h < 2d
  });
});

describe('assembleTodayView — the do-next cap (D29: doNext capped, counts are NOT)', () => {
  it('caps doNext at MAX_DO_NEXT_CARDS while taskCounts stays uncapped', () => {
    const n = MAX_DO_NEXT_CARDS + 10;
    const manyThreads: Thread[] = [];
    const manyTasks: Task[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `th-${i}`;
      manyThreads.push(thread(id, H1_AGO));
      manyTasks.push(task({ id: `task-${i}`, thread_id: id, state: 'needs-reply' }));
    }
    const big = assembleTodayView(
      {
        projectId: 'proj',
        threads: manyThreads,
        tasks: manyTasks,
        promises: [],
        draftMeta: [],
        settings: DEFAULT_APP_SETTINGS,
      },
      NOW,
    );
    expect(big.doNext).toHaveLength(MAX_DO_NEXT_CARDS);
    expect(big.taskCounts).toEqual({ remaining: n, done: 0 });
  });
});
