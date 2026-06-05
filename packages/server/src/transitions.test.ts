/**
 * Task transitions + optimistic concurrency (PROJECT.md §5/§6; PLAN.md §7 Phase 2 "task
 * transitions … 409 on stale `expected_from`").
 *
 * Intent: state changes are actor-attributed (powering the digest's "what Simona handled"); the
 * server derives `from` from the task's current state and stamps `at`. `expected_from` is optimistic
 * concurrency — if the task moved since the caller read it, the transition is stale and must 409
 * WITHOUT changing state. Transition LEGALITY (the §6 edge table) is intentionally the Phase 3 state
 * machine's job, not the wire contract — the server records any from→to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Task, TaskTransition } from '@mailordomo/shared';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { authHeaders, PROJECT_A, makeApp, readJson, seedProject, seedThread } from './test-helpers';

describe('task transitions', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
  });

  afterEach(() => {
    repo.close();
  });

  const newTask = async (): Promise<Task> => {
    const thread = seedThread(repo, PROJECT_A.id);
    return readJson<Task>(
      await app.request('/tasks', {
        method: 'POST',
        headers: authHeaders(PROJECT_A),
        body: JSON.stringify({ thread_id: thread.id }),
      }),
    );
  };

  const transition = async (taskId: string, payload: unknown): Promise<Response> =>
    app.request(`/tasks/${taskId}/transitions`, {
      method: 'POST',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify(payload),
    });

  it('records a transition with server-derived from + the supplied actor', async () => {
    const task = await newTask();
    const res = await transition(task.id, { to: 'drafted', actor: 'jan' });
    expect(res.status).toBe(201);
    const created = await readJson<TaskTransition>(res);
    expect(created).toMatchObject({
      task_id: task.id,
      from: 'needs-reply',
      to: 'drafted',
      actor: 'jan',
    });
    expect(typeof created.at).toBe('string');

    // the task's current state reflects the transition
    const after = await readJson<Task>(
      await app.request(`/tasks/${task.id}`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(after.state).toBe('drafted');
  });

  it('accepts a transition whose expected_from matches the current state', async () => {
    const task = await newTask();
    const res = await transition(task.id, {
      to: 'drafted',
      actor: 'jan',
      expected_from: 'needs-reply',
    });
    expect(res.status).toBe(201);
  });

  it('409s a STALE transition (expected_from no longer matches) and leaves state unchanged', async () => {
    const task = await newTask();
    // advance the task to `drafted`
    expect((await transition(task.id, { to: 'drafted', actor: 'jan' })).status).toBe(201);

    // a second client still believes it is `needs-reply`
    const stale = await transition(task.id, {
      to: 'waiting',
      actor: 'simona',
      expected_from: 'needs-reply',
    });
    expect(stale.status).toBe(409);

    // the stale attempt must NOT have moved the task
    const after = await readJson<Task>(
      await app.request(`/tasks/${task.id}`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(after.state).toBe('drafted');
  });

  it('404s a transition on an unknown task', async () => {
    const res = await transition('no-such-task', { to: 'drafted', actor: 'jan' });
    expect(res.status).toBe(404);
  });

  it('404s the transition history of an unknown task', async () => {
    const res = await app.request('/tasks/no-such-task/transitions', {
      headers: authHeaders(PROJECT_A),
    });
    expect(res.status).toBe(404);
  });
});
