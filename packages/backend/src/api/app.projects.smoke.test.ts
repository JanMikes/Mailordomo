/**
 * SMOKE — the Phase 7c (D32) endpoints on {@link createBackendApi}: `GET /api/projects-board` (the
 * body-free board grouped by state), `GET /api/project` (the cached project identity), and the
 * project-name resolver's caching + degradation as observed through the API. Uses an in-memory
 * {@link MessageCache} + a stub `fetch` on the MetadataClient (no socket). The exhaustive suite is the
 * separate test-author's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  ProjectResponseSchema,
  ProjectsBoardResponseSchema,
} from '@mailordomo/shared';
import type { AppSettings, Task, Thread } from '@mailordomo/shared';
import { AppSettingsSchema } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import type { FetchLike } from '../metadata-client';
import type { SettingsStore } from '../settings';
import { createBackendApi } from './app';

let cache: MessageCache;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
});
afterEach(() => {
  cache.close();
});

function memStore(initial: AppSettings = { ...DEFAULT_APP_SETTINGS }): SettingsStore {
  let current = initial;
  return {
    read: () => current,
    write: (patch) => {
      current = AppSettingsSchema.parse({ ...current, ...patch });
      return current;
    },
  };
}

const NOW = '2026-06-06T12:00:00.000Z';
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const THREADS: Thread[] = [
  {
    id: 'th-a',
    project_id: 'proj_1',
    mailbox_address: 'jan@acme.com',
    root_message_id: '<a@acme.com>',
    subject: 'Invoice',
    snippet: 'send the invoice',
    sender: 'Petr <petr@acme.com>',
    last_message_at: NOW,
    updated_at: NOW,
  },
  {
    id: 'th-orphan', // no task → must land in needs-reply
    project_id: 'proj_1',
    mailbox_address: 'jan@acme.com',
    root_message_id: '<o@acme.com>',
    subject: 'Hello',
    snippet: 'no task yet',
    sender: 'Lumír <lumir@acme.com>',
    last_message_at: NOW,
    updated_at: NOW,
  },
];
const TASKS: Task[] = [
  {
    id: 't1',
    thread_id: 'th-a',
    state: 'waiting',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
  },
];

/** A router serving the board's metadata reads + a `/pair` that records how many times it's hit. */
function boardRouter(opts: { pairFails?: boolean; pairCalls?: { n: number } }): FetchLike {
  return (url, init) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/pair') && method === 'POST') {
      if (opts.pairCalls) opts.pairCalls.n += 1;
      if (opts.pairFails) return Promise.resolve(json({ error: 'unpaired' }, 401));
      return Promise.resolve(json({ project: { id: 'proj_1', name: 'Acme Corp' } }));
    }
    if (method === 'GET' && url.includes('/threads')) return Promise.resolve(json(THREADS));
    if (method === 'GET' && url.includes('/tasks')) return Promise.resolve(json(TASKS));
    if (method === 'GET' && url.includes('/promises')) return Promise.resolve(json([]));
    if (method === 'GET' && url.includes('/drafts')) return Promise.resolve(json([]));
    return Promise.resolve(json({ error: 'unexpected' }, 500));
  };
}

function appWith(router: FetchLike) {
  const metadata = new MetadataClient({
    baseUrl: 'http://metadata.local',
    projectId: 'proj_1',
    token: 'sekret',
    fetch: router,
  });
  return createBackendApi({ metadata, cache, settingsStore: memStore() });
}

describe('GET /api/projects-board (D32)', () => {
  it('returns a valid body-free board, grouped by state, with the resolved project name', async () => {
    const app = appWith(boardRouter({}));
    const res = await app.request('/api/projects-board');
    expect(res.status).toBe(200);
    const board = ProjectsBoardResponseSchema.parse(await res.json()); // strict + body-free
    const entry = board.projects[0];
    expect(entry?.projectId).toBe('proj_1');
    expect(entry?.projectName).toBe('Acme Corp'); // resolved via pair()
    expect(entry?.groups.waiting.map((c) => c.threadId)).toEqual(['th-a']);
    // The task-less thread is never dropped — it lands under needs-reply.
    expect(entry?.groups['needs-reply'].map((c) => c.threadId)).toEqual(['th-orphan']);
  });

  it('null project name + empty groups when metadata is unreachable (never throws)', async () => {
    const failing = new MetadataClient({
      baseUrl: 'http://metadata.local',
      projectId: 'proj_1',
      token: 'sekret',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const app = createBackendApi({ metadata: failing, cache, settingsStore: memStore() });
    const res = await app.request('/api/projects-board');
    expect(res.status).toBe(200);
    const board = ProjectsBoardResponseSchema.parse(await res.json());
    expect(board.projects[0]?.projectName).toBeNull();
    expect(board.projects[0]?.counts).toMatchObject({ 'needs-reply': 0, waiting: 0, done: 0 });
  });

  it('null project name when pair() is rejected but the rest still assembles', async () => {
    const app = appWith(boardRouter({ pairFails: true }));
    const res = await app.request('/api/projects-board');
    expect(res.status).toBe(200);
    const board = ProjectsBoardResponseSchema.parse(await res.json());
    expect(board.projects[0]?.projectName).toBeNull(); // pair failed → null, but threads still grouped
    expect(board.projects[0]?.groups.waiting.map((c) => c.threadId)).toEqual(['th-a']);
  });
});

describe('GET /api/project (D32)', () => {
  it('returns the configured id + resolved name', async () => {
    const app = appWith(boardRouter({}));
    const res = await app.request('/api/project');
    expect(res.status).toBe(200);
    const payload = ProjectResponseSchema.parse(await res.json());
    expect(payload).toEqual({ id: 'proj_1', name: 'Acme Corp' });
  });

  it('returns the id with a null name when pair() fails', async () => {
    const app = appWith(boardRouter({ pairFails: true }));
    const res = await app.request('/api/project');
    expect(res.status).toBe(200);
    expect(ProjectResponseSchema.parse(await res.json())).toEqual({ id: 'proj_1', name: null });
  });
});

describe('project-name resolver caching (D32)', () => {
  it('calls pair() once across multiple reads once resolved', async () => {
    const pairCalls = { n: 0 };
    const app = appWith(boardRouter({ pairCalls }));
    await app.request('/api/project');
    await app.request('/api/projects-board');
    await app.request('/api/project');
    expect(pairCalls.n).toBe(1); // memoized after the first success
  });
});

describe('/api/today projectName enrichment (D32)', () => {
  it('stamps the resolved project name onto each do-next card', async () => {
    const app = appWith(boardRouter({}));
    const res = await app.request('/api/today');
    expect(res.status).toBe(200);
    const model = (await res.json()) as { doNext: { projectName: string | null }[] };
    expect(model.doNext.length).toBeGreaterThan(0);
    for (const card of model.doNext) expect(card.projectName).toBe('Acme Corp');
  });
});
