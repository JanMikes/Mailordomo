/**
 * INTENT (separate test-author) — the Phase 7c projects-board ENGINE + project-name RESOLVER, derived
 * from PROJECT.md §11 (all-projects/per-project = threads GROUPED BY state; the classic fallback so the
 * user is NEVER trapped — it must never lose access to a thread), §6 (state order; `done` exists), and
 * PLAN.md D32 (board grouped by state, NAME from cached `pair()`).
 *
 * ADDITIVE to `projects-board-view.smoke.test.ts` / `app.projects.smoke.test.ts` — this suite is
 * adversarial about the LOAD-BEARING invariants the smokes only sample:
 *  - the NEVER-LOSE-A-THREAD invariant (asserted HARD: total cards across all groups === thread count,
 *    over randomized inputs incl. a no-task thread, a done thread, and threads with multiple tasks);
 *  - the resolver's CACHE + DEGRADATION contract: `pair()` AT MOST ONCE on success; failure → null +
 *    a later call RETRIES (failure NOT memoized); never throws, never blocks a read;
 *  - body-free BY CONSTRUCTION: a planted body key is caught by the scan (proving the probe bites).
 *
 * Pure engine + a tiny fake `ProjectPairer` — no network, no `claude`, deterministic.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AuthedProject,
  DraftMeta,
  PromiseRecord,
  Task,
  TaskState,
  Thread,
} from '@mailordomo/shared';
import { BoardThreadCardSchema, ProjectsBoardSchema, TASK_STATES } from '@mailordomo/shared';
import { assembleProjectsBoard } from './projects-board-view';
import { createProjectNameResolver } from './project-name';
import type { ProjectPairer } from './project-name';

const NOW = '2026-06-06T12:00:00.000Z';

function thread(id: string, lastAt: string | null): Thread {
  return {
    id,
    project_id: 'proj',
    mailbox_address: 'jan@acme.com',
    root_message_id: `<${id}@acme.com>`,
    subject: `subj-${id}`,
    snippet: `snippet ${id}`,
    sender: `Petr <petr+${id}@acme.com>`,
    last_message_at: lastAt,
    updated_at: NOW,
  };
}

function task(id: string, threadId: string, state: TaskState): Task {
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

function entryOf(input: Parameters<typeof assembleProjectsBoard>[0]) {
  const board = assembleProjectsBoard(input, NOW);
  const entry = board.projects[0];
  if (entry === undefined) throw new Error('expected one project entry');
  return entry;
}

/** Sum every group's length — the "where did each thread land" total. */
function totalCards(entry: ReturnType<typeof entryOf>): number {
  return TASK_STATES.reduce((sum, state) => sum + entry.groups[state].length, 0);
}

const PROJECTS = [{ projectId: 'proj', projectName: 'Acme' }] as const;

describe('assembleProjectsBoard — grouping by task state (PROJECT.md §11/§6)', () => {
  it('places each thread in its active task-state group; done is a real group', () => {
    const threads = TASK_STATES.map((s, i) => thread(`th-${s}`, `2026-06-0${i + 1}T08:00:00.000Z`));
    const tasks = TASK_STATES.map((s, i) => task(`t${i}`, `th-${s}`, s));
    const entry = entryOf({ projects: PROJECTS, threads, tasks, promises: [], draftMeta: [] });

    for (const state of TASK_STATES) {
      expect(entry.groups[state].map((c) => c.threadId)).toEqual([`th-${state}`]);
      expect(entry.counts[state]).toBe(1);
    }
    // `done` is included (unlike the do-next queue) — the board shows the whole lifecycle.
    expect(entry.groups.done.map((c) => c.threadId)).toEqual(['th-done']);
  });

  it('every canonical state key is present even when its group is empty', () => {
    const entry = entryOf({
      projects: PROJECTS,
      threads: [thread('only', NOW)],
      tasks: [task('t', 'only', 'waiting')],
      promises: [],
      draftMeta: [],
    });
    // All five keys exist on BOTH groups and counts; the four non-waiting ones are empty/zero.
    for (const state of TASK_STATES) {
      expect(entry.groups[state]).toBeDefined();
      expect(entry.counts[state]).toBe(state === 'waiting' ? 1 : 0);
    }
    expect(Object.keys(entry.groups).sort()).toEqual([...TASK_STATES].sort());
  });
});

describe('assembleProjectsBoard — NEVER LOSE A THREAD (the §11 "never trapped" rule)', () => {
  it('a thread with NO metadata task is bucketed under needs-reply (never dropped)', () => {
    const entry = entryOf({
      projects: PROJECTS,
      threads: [thread('orphan', NOW)],
      tasks: [], // no task at all
      promises: [],
      draftMeta: [],
    });
    expect(entry.groups['needs-reply'].map((c) => c.threadId)).toEqual(['orphan']);
    expect(totalCards(entry)).toBe(1);
  });

  it('total cards across ALL groups === thread count, over a messy mix (the hard invariant)', () => {
    // A deliberately adversarial set: a no-task thread, a done thread, a thread with TWO tasks
    // (one done + one active → the active drives the bucket), and one per remaining state.
    const threads: Thread[] = [
      thread('a', '2026-06-01T08:00:00.000Z'), // no task → needs-reply
      thread('b', '2026-06-02T08:00:00.000Z'), // done
      thread('c', '2026-06-03T08:00:00.000Z'), // done + waiting (active drives)
      thread('d', '2026-06-04T08:00:00.000Z'), // drafted
      thread('e', '2026-06-05T08:00:00.000Z'), // follow-up
      thread('f', null), // needs-reply, unknown activity
    ];
    const tasks: Task[] = [
      task('tb', 'b', 'done'),
      task('tc-done', 'c', 'done'),
      task('tc-wait', 'c', 'waiting'),
      task('td', 'd', 'drafted'),
      task('te', 'e', 'follow-up'),
      task('tf', 'f', 'needs-reply'),
    ];
    const entry = entryOf({ projects: PROJECTS, threads, tasks, promises: [], draftMeta: [] });

    // No thread is dropped; none is double-counted.
    expect(totalCards(entry)).toBe(threads.length);
    const allIds = TASK_STATES.flatMap((s) => entry.groups[s].map((c) => c.threadId)).sort();
    expect(allIds).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // The multi-task thread lands under its ACTIVE (non-done) task's state, not `done`.
    expect(entry.groups.waiting.map((c) => c.threadId)).toContain('c');
    expect(entry.groups.done.map((c) => c.threadId)).toEqual(['b']);
    // counts mirror the group lengths exactly.
    for (const state of TASK_STATES) expect(entry.counts[state]).toBe(entry.groups[state].length);
  });

  it('drops nothing even when EVERY thread lacks a task (all fall to needs-reply)', () => {
    const threads = Array.from({ length: 7 }, (_, i) => thread(`n${i}`, NOW));
    const entry = entryOf({ projects: PROJECTS, threads, tasks: [], promises: [], draftMeta: [] });
    expect(entry.counts['needs-reply']).toBe(7);
    expect(totalCards(entry)).toBe(7);
  });
});

describe('assembleProjectsBoard — within-group sort + card metadata', () => {
  it('sorts a group most-recent-first by lastActivityAt (nulls last), stable on threadId', () => {
    const threads: Thread[] = [
      thread('old', '2026-06-01T08:00:00.000Z'),
      thread('new', '2026-06-09T08:00:00.000Z'),
      thread('mid', '2026-06-05T08:00:00.000Z'),
      thread('nullact', null),
    ];
    const tasks = threads.map((t, i) => task(`t${i}`, t.id, 'needs-reply'));
    const entry = entryOf({ projects: PROJECTS, threads, tasks, promises: [], draftMeta: [] });
    expect(entry.groups['needs-reply'].map((c) => c.threadId)).toEqual([
      'new',
      'mid',
      'old',
      'nullact', // null activity sinks to the bottom
    ]);
  });

  it('carries body-free card metadata: draft-ready flag + unique promise directions', () => {
    const threads = [thread('th', NOW)];
    const tasks = [task('t', 'th', 'needs-reply')];
    const promises: PromiseRecord[] = [
      promise('p1', 'th', 'they-asked'),
      promise('p2', 'th', 'they-asked'), // duplicate direction → de-duplicated
      promise('p3', 'th', 'my-promise'),
    ];
    const draftMeta: DraftMeta[] = [
      { id: 'd1', thread_id: 'th', version: 1, model: 'opus', author: 'claude', at: NOW },
    ];
    const entry = entryOf({ projects: PROJECTS, threads, tasks, promises, draftMeta });
    const card = entry.groups['needs-reply'][0];
    expect(card?.hasDraftReady).toBe(true);
    // Canonical 3-way order, unique set (my-promise before they-asked).
    expect(card?.promiseDirections).toEqual(['my-promise', 'they-asked']);
  });
});

describe('assembleProjectsBoard — PRIVACY (golden rule #3, body-free by construction)', () => {
  const board = assembleProjectsBoard(
    {
      projects: PROJECTS,
      threads: [thread('th', NOW)],
      tasks: [task('t', 'th', 'waiting')],
      promises: [],
      draftMeta: [],
    },
    NOW,
  );

  it('the assembled board carries no body key', () => {
    // Strict schema parses (no smuggled key) and no body-ish substring appears anywhere.
    expect(() => ProjectsBoardSchema.parse(board)).not.toThrow();
    expect(JSON.stringify(board)).not.toMatch(/"body"|"draftBody"|"\.eml"|"html"/);
  });

  it('the scan/strict-schema probe BITES when a body is planted on a card (non-vacuous)', () => {
    const card = board.projects[0]?.groups.waiting[0];
    expect(card).toBeDefined();
    const tainted = { ...(card as Record<string, unknown>), body: 'secret email text' };
    expect(() => BoardThreadCardSchema.parse(tainted)).toThrow(); // strict rejects the smuggled key
    expect(JSON.stringify(tainted)).toContain('"body"'); // and the scan would catch it
  });
});

/* ===================== project-name resolver (D32 cache + degradation) ===================== */

function authed(name: string): AuthedProject {
  return { id: 'proj_1', name };
}

/** A fake pairer recording calls; `pair()` succeeds with `name` unless `fail` is set for that call. */
function fakePairer(opts: {
  name?: string;
  /** Sequence of outcomes per call: 'ok' resolves, 'fail' rejects. Repeats the last when exhausted. */
  outcomes?: ('ok' | 'fail')[];
}): { pairer: ProjectPairer; calls: () => number } {
  let n = 0;
  const outcomes = opts.outcomes ?? ['ok'];
  const pairer: ProjectPairer = {
    getProjectId: () => 'proj_1',
    pair: () => {
      const outcome = outcomes[Math.min(n, outcomes.length - 1)];
      n += 1;
      if (outcome === 'fail') return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(authed(opts.name ?? 'Acme Corp'));
    },
  };
  return { pairer, calls: () => n };
}

describe('project-name resolver — caching (D32)', () => {
  it('calls pair() AT MOST ONCE across many reads once resolved', async () => {
    const { pairer, calls } = fakePairer({ name: 'Acme Corp' });
    const resolver = createProjectNameResolver(pairer);
    expect(await resolver.resolveName()).toBe('Acme Corp');
    expect(await resolver.resolveName()).toBe('Acme Corp');
    expect(await resolver.resolveName()).toBe('Acme Corp');
    expect(calls()).toBe(1); // memoized after the first success
  });

  it('coalesces concurrent first-resolution callers onto ONE pair() round-trip', async () => {
    const { pairer, calls } = fakePairer({ name: 'Acme Corp' });
    const resolver = createProjectNameResolver(pairer);
    const [a, b, c] = await Promise.all([
      resolver.resolveName(),
      resolver.resolveName(),
      resolver.resolveName(),
    ]);
    expect([a, b, c]).toEqual(['Acme Corp', 'Acme Corp', 'Acme Corp']);
    expect(calls()).toBe(1); // in-flight promise shared, not 3 calls
  });

  it('projectId() is always known (local config) without any pair() call', () => {
    const { pairer, calls } = fakePairer({});
    const resolver = createProjectNameResolver(pairer);
    expect(resolver.projectId()).toBe('proj_1');
    expect(calls()).toBe(0);
  });
});

describe('project-name resolver — degradation (D32: best-effort, never throws, retries)', () => {
  it('resolves to null when pair() throws — never throwing, never blocking', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pairer } = fakePairer({ outcomes: ['fail'] });
    const resolver = createProjectNameResolver(pairer);
    await expect(resolver.resolveName()).resolves.toBeNull();
    errSpy.mockRestore();
  });

  it('does NOT memoize a failure — a later call RETRIES and succeeds once metadata is back', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // First pair() fails, the SECOND succeeds.
    const { pairer, calls } = fakePairer({ name: 'Acme Corp', outcomes: ['fail', 'ok'] });
    const resolver = createProjectNameResolver(pairer);

    expect(await resolver.resolveName()).toBeNull(); // 1st call: failed → null
    expect(calls()).toBe(1);
    expect(await resolver.resolveName()).toBe('Acme Corp'); // 2nd call: retried → resolved
    expect(calls()).toBe(2);
    // And now it's cached — no third call.
    expect(await resolver.resolveName()).toBe('Acme Corp');
    expect(calls()).toBe(2);
    errSpy.mockRestore();
  });
});

/* shared promise factory used above */
function promise(
  id: string,
  threadId: string,
  direction: PromiseRecord['direction'],
): PromiseRecord {
  return {
    id,
    thread_id: threadId,
    direction,
    text: 'p',
    due_at: null,
    due_raw: null,
    status: 'open',
    actor: 'petr',
    created_at: NOW,
  };
}
