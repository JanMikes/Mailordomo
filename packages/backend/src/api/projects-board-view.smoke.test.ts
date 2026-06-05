/**
 * SMOKE — the pure {@link assembleProjectsBoard} (PROJECT.md §11 / D32). Thin coverage; the separate
 * test-author writes the full suite. Here we prove the load-bearing invariants: every thread is
 * grouped by its task state, a thread with NO metadata task is bucketed under `needs-reply` (never
 * dropped — the fallback-never-loses-a-thread rule), `done` is included, the cards are body-free, and
 * each group is sorted most-recent-first.
 */
import { describe, expect, it } from 'vitest';
import type { DraftMeta, PromiseRecord, Task, Thread } from '@mailordomo/shared';
import { ProjectsBoardSchema } from '@mailordomo/shared';
import { assembleProjectsBoard } from './projects-board-view';

const NOW = '2026-06-06T12:00:00.000Z';

function thread(id: string, lastAt: string | null, subject = `subj-${id}`): Thread {
  return {
    id,
    project_id: 'proj',
    mailbox_address: 'jan@acme.com',
    root_message_id: `<${id}@acme.com>`,
    subject,
    snippet: `snippet ${id}`,
    sender: `Petr <petr+${id}@acme.com>`,
    last_message_at: lastAt,
    updated_at: NOW,
  };
}

function task(id: string, threadId: string, state: Task['state']): Task {
  return {
    id,
    thread_id: threadId,
    state,
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
  };
}

// th-need (needs-reply), th-wait (waiting), th-done (done), th-orphan (NO task → needs-reply bucket).
const threads: Thread[] = [
  thread('th-need', '2026-06-06T08:00:00.000Z'),
  thread('th-wait', '2026-06-05T08:00:00.000Z'),
  thread('th-done', '2026-06-04T08:00:00.000Z'),
  thread('th-orphan', '2026-06-06T09:00:00.000Z'), // newest activity → sorts first in needs-reply
];
const tasks: Task[] = [
  task('t1', 'th-need', 'needs-reply'),
  task('t2', 'th-wait', 'waiting'),
  task('t3', 'th-done', 'done'),
  // th-orphan has no task on purpose.
];
const promises: PromiseRecord[] = [
  {
    id: 'p1',
    thread_id: 'th-need',
    direction: 'they-asked',
    text: 'they need it',
    due_at: null,
    due_raw: null,
    status: 'open',
    actor: 'petr',
    created_at: NOW,
  },
];
const draftMeta: DraftMeta[] = [
  { id: 'd1', thread_id: 'th-wait', version: 1, model: 'opus', author: 'claude', at: NOW },
];

describe('assembleProjectsBoard', () => {
  const board = assembleProjectsBoard(
    { projects: [{ projectId: 'proj', projectName: 'Acme' }], tasks, threads, promises, draftMeta },
    NOW,
  );
  const entry = board.projects[0];

  it('produces a strict, body-free, valid board', () => {
    expect(() => ProjectsBoardSchema.parse(board)).not.toThrow();
    expect(JSON.stringify(board)).not.toContain('"body"');
    expect(board.generatedAt).toBe(NOW);
    expect(entry?.projectId).toBe('proj');
    expect(entry?.projectName).toBe('Acme');
  });

  it('groups each thread under its task state and includes done', () => {
    expect(entry?.groups.waiting.map((c) => c.threadId)).toEqual(['th-wait']);
    expect(entry?.groups.done.map((c) => c.threadId)).toEqual(['th-done']);
    expect(entry?.counts.waiting).toBe(1);
    expect(entry?.counts.done).toBe(1);
    expect(entry?.counts.drafted).toBe(0);
    expect(entry?.counts['follow-up']).toBe(0);
  });

  it('buckets a thread with NO metadata task under needs-reply (never drops it)', () => {
    const needs = entry?.groups['needs-reply'].map((c) => c.threadId) ?? [];
    expect(needs).toContain('th-orphan');
    expect(needs).toContain('th-need');
    expect(entry?.counts['needs-reply']).toBe(2);
    // Every thread is accounted for somewhere — the fallback never loses access to a thread.
    const total = Object.values(entry?.counts ?? {}).reduce((a, b) => a + b, 0);
    expect(total).toBe(threads.length);
  });

  it('sorts a group most-recent-first by lastActivityAt', () => {
    // th-orphan (06-06 09:00) is newer than th-need (06-06 08:00).
    expect(entry?.groups['needs-reply'].map((c) => c.threadId)).toEqual(['th-orphan', 'th-need']);
  });

  it('carries body-free card metadata (draft flag + promise dots)', () => {
    const waitCard = entry?.groups.waiting[0];
    expect(waitCard?.hasDraftReady).toBe(true); // draft metadata exists on th-wait
    const needCard = entry?.groups['needs-reply'].find((c) => c.threadId === 'th-need');
    expect(needCard?.promiseDirections).toEqual(['they-asked']);
    expect(needCard?.hasDraftReady).toBe(false);
  });
});
