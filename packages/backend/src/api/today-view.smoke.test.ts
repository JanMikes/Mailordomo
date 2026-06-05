/**
 * SMOKE — the pure {@link assembleTodayView} (PROJECT.md §11 / D26 / D29). Thin coverage; the
 * separate test-author writes the full suite (metric edge cases, ranking, urgency bands, the cap).
 * Here we prove the happy path: metrics by direction, done/remaining counts, the D26 two-tier
 * ordering, the urgency labels + draft flag, and that the model is strict + body-free.
 */
import { describe, expect, it } from 'vitest';
import type { DraftMeta, PromiseRecord, Task, Thread } from '@mailordomo/shared';
import { DEFAULT_APP_SETTINGS, TodayReadModelSchema } from '@mailordomo/shared';
import { assembleTodayView } from './today-view';

const NOW = '2026-06-05T12:00:00.000Z';

const threads: Thread[] = [
  {
    id: 'th-a',
    project_id: 'proj',
    mailbox_address: 'jan@acme.com',
    root_message_id: '<a@acme.com>',
    subject: 'Invoice',
    snippet: 'Please send the invoice',
    sender: 'Petr <petr@acme.com>',
    last_message_at: '2026-06-05T08:00:00.000Z',
    updated_at: NOW,
  },
  {
    id: 'th-b',
    project_id: 'proj',
    mailbox_address: 'jan@acme.com',
    root_message_id: '<b@acme.com>',
    subject: 'Report',
    snippet: 'awaiting the quarterly report',
    sender: 'Lumír <lumir@acme.com>',
    last_message_at: '2026-06-04T08:00:00.000Z',
    updated_at: NOW,
  },
];

const tasks: Task[] = [
  {
    id: 'task-a',
    thread_id: 'th-a',
    state: 'needs-reply',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
  },
  {
    id: 'task-b',
    thread_id: 'th-b',
    state: 'waiting',
    deadline: null,
    follow_up_at: '2026-06-02T00:00:00.000Z', // passed → stale
    importance: 'normal',
    updated_at: NOW,
  },
  {
    id: 'task-c',
    thread_id: 'th-c', // no cached thread → no card, but still a done count
    state: 'done',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
  },
];

const promises: PromiseRecord[] = [
  {
    id: 'p1',
    thread_id: 'th-b',
    direction: 'my-promise',
    text: 'I will send the report',
    due_at: '2026-06-01T00:00:00.000Z', // overdue
    due_raw: null,
    status: 'overdue',
    actor: 'me',
    created_at: NOW,
  },
  {
    id: 'p2',
    thread_id: 'th-a',
    direction: 'they-asked',
    text: 'they need the invoice',
    due_at: '2026-06-20T00:00:00.000Z', // future > 48h → 'dated'
    due_raw: null,
    status: 'open',
    actor: 'petr',
    created_at: NOW,
  },
  {
    id: 'p3',
    thread_id: 'th-a',
    direction: 'awaiting-them',
    text: 'they will confirm receipt',
    due_at: null,
    due_raw: null,
    status: 'open',
    actor: 'petr',
    created_at: NOW,
  },
];

const draftMeta: DraftMeta[] = [
  { id: 'd1', thread_id: 'th-a', version: 1, model: 'opus', author: 'claude', at: NOW },
];

describe('assembleTodayView', () => {
  const model = assembleTodayView(
    { projectId: 'proj', tasks, threads, promises, draftMeta, settings: DEFAULT_APP_SETTINGS },
    NOW,
  );

  it('produces a strict, body-free, valid read model', () => {
    expect(() => TodayReadModelSchema.parse(model)).not.toThrow();
    expect(JSON.stringify(model)).not.toContain('"body"');
    expect(model.generatedAt).toBe(NOW);
    expect(model.projectId).toBe('proj');
  });

  it('counts promises by direction (total / open / overdue)', () => {
    expect(model.promiseMetrics.myPromises).toEqual({ total: 1, openCount: 1, overdueCount: 1 });
    expect(model.promiseMetrics.theyAsked).toEqual({ total: 1, openCount: 1, overdueCount: 0 });
    expect(model.promiseMetrics.awaitingThem).toEqual({ total: 1, openCount: 1, overdueCount: 0 });
  });

  it('counts done vs remaining over all tasks', () => {
    expect(model.taskCounts).toEqual({ remaining: 2, done: 1 });
  });

  it('orders do-next by the D26 two-tier key (my-promise overdue > they-asked)', () => {
    expect(model.doNext.map((c) => c.threadId)).toEqual(['th-b', 'th-a']);
  });

  it('derives urgency labels, the draft flag, present directions, and the stale reason', () => {
    const [b, a] = model.doNext;
    expect(b?.myPromiseUrgency).toBe('overdue');
    expect(b?.theyAskedUrgency).toBeNull();
    expect(b?.staleReason).toBe('follow-up-deadline-passed');
    expect(b?.hasDraftReady).toBe(false);
    expect(b?.promiseDirections).toEqual(['my-promise']);

    expect(a?.myPromiseUrgency).toBeNull();
    expect(a?.theyAskedUrgency).toBe('dated');
    expect(a?.hasDraftReady).toBe(true); // draft metadata exists on th-a
    expect(a?.staleReason).toBeNull();
    expect(a?.promiseDirections).toEqual(['they-asked', 'awaiting-them']);
  });
});
