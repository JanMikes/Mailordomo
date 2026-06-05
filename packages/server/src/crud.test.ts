/**
 * CRUD round-trips + project scoping (PROJECT.md §5 data model; PLAN.md §7 Phase 2 "CRUD
 * round-trips").
 *
 * Intent: each metadata entity the local app pushes (threads, tasks, promises, notes, repo
 * pointers, draft metadata) must survive a create → read-back unchanged, and every row is scoped to
 * the authenticated project — one project can NEVER read or mutate another's data (the privacy +
 * sharing boundary in §3/§5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type {
  DraftMeta,
  Note,
  PromiseRecord,
  RepoPointer,
  Task,
  TaskTransition,
  Thread,
} from '@mailordomo/shared';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import {
  authHeaders,
  PROJECT_A,
  PROJECT_B,
  makeApp,
  readJson,
  seedProject,
  seedThread,
} from './test-helpers';

describe('CRUD round-trips (create → read back; values survive)', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
  });

  afterEach(() => {
    repo.close();
  });

  const post = async (path: string, payload: unknown): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify(payload),
    });

  it('threads: upsert then read back the sanctioned subject/snippet/sender', async () => {
    const res = await post('/threads', {
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<thread-1@host>',
      subject: 'Invoice question',
      snippet: 'Could you clarify line 4?',
      sender: 'Lumír <lumir@acme.com>',
      last_message_at: null,
    });
    expect(res.status).toBe(200);
    const created = await readJson<Thread>(res);
    expect(created).toMatchObject({
      project_id: PROJECT_A.id,
      subject: 'Invoice question',
      snippet: 'Could you clarify line 4?',
      sender: 'Lumír <lumir@acme.com>',
    });
    expect(typeof created.id).toBe('string');

    const back = await app.request(`/threads/${created.id}`, { headers: authHeaders(PROJECT_A) });
    expect(back.status).toBe(200);
    expect(await readJson<Thread>(back)).toEqual(created);
  });

  it('tasks: create then read back; deadline instant + importance survive', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const res = await post('/tasks', {
      thread_id: thread.id,
      state: 'needs-reply',
      importance: 'high',
      deadline: '2026-07-01T09:00:00Z',
    });
    expect(res.status).toBe(201);
    const created = await readJson<Task>(res);
    expect(created).toMatchObject({
      thread_id: thread.id,
      state: 'needs-reply',
      importance: 'high',
    });
    expect(created.deadline).not.toBeNull();
    expect(Date.parse(String(created.deadline))).toBe(Date.parse('2026-07-01T09:00:00Z'));

    const back = await app.request(`/tasks/${created.id}`, { headers: authHeaders(PROJECT_A) });
    expect(back.status).toBe(200);
    expect(await readJson<Task>(back)).toEqual(created);
  });

  it('tasks: PATCH updates importance/deadline and reads back', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const created = await readJson<Task>(await post('/tasks', { thread_id: thread.id }));
    const patched = await app.request(`/tasks/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify({ importance: 'low' }),
    });
    expect(patched.status).toBe(200);
    expect((await readJson<Task>(patched)).importance).toBe('low');
  });

  it('promises: create then read back; direction/text/due_raw/default-status survive', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const res = await post('/promises', {
      thread_id: thread.id,
      direction: 'my-promise',
      text: 'Send the report',
      due_raw: 'by Friday',
      actor: 'jan',
    });
    expect(res.status).toBe(201);
    const created = await readJson<PromiseRecord>(res);
    expect(created).toMatchObject({
      thread_id: thread.id,
      direction: 'my-promise',
      text: 'Send the report',
      due_raw: 'by Friday',
      status: 'open',
      actor: 'jan',
    });

    const list = await readJson<PromiseRecord[]>(
      await app.request(`/promises?thread_id=${thread.id}`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toContainEqual(created);
  });

  it('notes: create then read back the (sanctioned) user note body', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const res = await post('/notes', {
      thread_id: thread.id,
      author: 'jan',
      body: 'Remember to CC Simona.',
    });
    expect(res.status).toBe(201);
    const created = await readJson<Note>(res);
    expect(created).toMatchObject({ author: 'jan', body: 'Remember to CC Simona.' });

    const list = await readJson<Note[]>(
      await app.request(`/notes?thread_id=${thread.id}`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toContainEqual(created);
  });

  it('repos: create then read back identity (name + git_url)', async () => {
    const res = await post('/repos', {
      project_id: PROJECT_A.id,
      name: 'acme-app',
      git_url: 'git@github.com:acme/app.git',
    });
    expect(res.status).toBe(201);
    const created = await readJson<RepoPointer>(res);
    expect(created).toMatchObject({
      project_id: PROJECT_A.id,
      name: 'acme-app',
      git_url: 'git@github.com:acme/app.git',
    });

    const list = await readJson<RepoPointer[]>(
      await app.request('/repos', { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toContainEqual(created);
  });

  it('drafts: create then read back METADATA ONLY (model/version/author)', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const res = await post('/drafts', {
      thread_id: thread.id,
      version: 2,
      model: 'opus',
      author: 'claude',
    });
    expect(res.status).toBe(201);
    const created = await readJson<DraftMeta>(res);
    expect(created).toMatchObject({
      thread_id: thread.id,
      version: 2,
      model: 'opus',
      author: 'claude',
    });

    const list = await readJson<DraftMeta[]>(
      await app.request(`/drafts?thread_id=${thread.id}`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(list).toContainEqual(created);
  });

  it('transitions: read back the actor-attributed history', async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const task = await readJson<Task>(await post('/tasks', { thread_id: thread.id }));
    await post(`/tasks/${task.id}/transitions`, { to: 'drafted', actor: 'simona' });

    const history = await readJson<TaskTransition[]>(
      await app.request(`/tasks/${task.id}/transitions`, { headers: authHeaders(PROJECT_A) }),
    );
    expect(history).toHaveLength(1);
    expect(history).toContainEqual(
      expect.objectContaining({ from: 'needs-reply', to: 'drafted', actor: 'simona' }),
    );
  });
});

describe("project scoping (one project cannot read or mutate another's rows)", () => {
  let app: Hono<AppEnv>;
  let repo: Repository;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
    seedProject(repo, PROJECT_B);
  });

  afterEach(() => {
    repo.close();
  });

  it("project B cannot list or fetch project A's thread", async () => {
    const thread = seedThread(repo, PROJECT_A.id);

    const list = await readJson<Thread[]>(
      await app.request('/threads', { headers: authHeaders(PROJECT_B) }),
    );
    expect(list).toEqual([]);

    const fetched = await app.request(`/threads/${thread.id}`, { headers: authHeaders(PROJECT_B) });
    expect(fetched.status).toBe(404);
  });

  it("project B cannot fetch project A's task", async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const task = await readJson<Task>(
      await app.request('/tasks', {
        method: 'POST',
        headers: authHeaders(PROJECT_A),
        body: JSON.stringify({ thread_id: thread.id }),
      }),
    );

    const fetched = await app.request(`/tasks/${task.id}`, { headers: authHeaders(PROJECT_B) });
    expect(fetched.status).toBe(404);
  });

  it("project B cannot attach a task to project A's thread (404, not 201)", async () => {
    const thread = seedThread(repo, PROJECT_A.id);
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: authHeaders(PROJECT_B),
      body: JSON.stringify({ thread_id: thread.id }),
    });
    expect(res.status).toBe(404);
  });
});
