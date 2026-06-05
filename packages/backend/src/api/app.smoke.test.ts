/**
 * MINIMAL smoke tests for {@link createBackendApi} — proving the factory wires and the endpoints
 * return the documented shapes. Uses an IN-MEMORY {@link MessageCache}, an in-memory settings store,
 * and either INJECTED health checks or a stub `fetch` on the MetadataClient (no socket, no `which
 * claude`, no live server). The load-bearing Today/settings/ranker suites are the separate
 * test-author's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, WsMessage } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS, TodayResponseSchema } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import type { FetchLike } from '../metadata-client';
import type { SettingsStore } from '../settings';
import type { WiringReport } from './wiring';
import type { MarkDoneResponse, ThreadsResponse } from './app';
import { createBackendApi } from './app';

let cache: MessageCache;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
});

afterEach(() => {
  cache.close();
});

/** A client pointed at a dead URL — every metadata call rejects (used to prove graceful degradation). */
function deadClient(): MetadataClient {
  return new MetadataClient({ baseUrl: 'http://unused.local', projectId: 'p', token: 't' });
}

/** A client whose `fetch` is a canned router (method+path → response). */
function stubClient(fetchImpl: FetchLike): MetadataClient {
  return new MetadataClient({
    baseUrl: 'http://metadata.local',
    projectId: 'proj_1',
    token: 'sekret',
    fetch: fetchImpl,
  });
}

/** A trivial in-memory settings store (the file store is covered in `store.smoke.test.ts`). */
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

describe('createBackendApi — wiring + threads (Phase 4.5)', () => {
  it('GET /api/wiring reports all three layers green when the checks pass', async () => {
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      checkMetadata: () => Promise.resolve({ ok: true, detail: 'paired' }),
      checkClaude: () => Promise.resolve({ ok: true, detail: 'on PATH' }),
    });
    const res = await app.request('/api/wiring');
    expect(res.status).toBe(200);
    const report = (await res.json()) as WiringReport;
    expect(report.metadataService.ok).toBe(true);
    expect(report.cache.ok).toBe(true);
    expect(report.claude.ok).toBe(true);
  });

  it('GET /api/threads returns an empty list for a fresh cache', async () => {
    const app = createBackendApi({ metadata: deadClient(), cache, settingsStore: memStore() });
    const res = await app.request('/api/threads');
    expect(res.status).toBe(200);
    expect((await res.json()) as ThreadsResponse).toEqual({ threads: [], count: 0 });
  });
});

describe('createBackendApi — settings (Phase 7a)', () => {
  it('GET /api/settings returns the current settings', async () => {
    const app = createBackendApi({ metadata: deadClient(), cache, settingsStore: memStore() });
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    expect((await res.json()) as AppSettings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('PUT /api/settings patches, persists, and broadcasts today:changed', async () => {
    const sent: WsMessage[] = [];
    const store = memStore();
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: store,
      broadcast: (msg) => sent.push(msg),
    });
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 7 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AppSettings).waitingStaleDays).toBe(7);
    expect(store.read().waitingStaleDays).toBe(7); // persisted
    expect(sent).toEqual([{ type: 'today:changed' }]); // clients refetch
  });

  it('PUT /api/settings rejects an unknown / invalid key with 400', async () => {
    const app = createBackendApi({ metadata: deadClient(), cache, settingsStore: memStore() });
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 0, nope: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('createBackendApi — Today (Phase 7a)', () => {
  it('GET /api/today degrades to a valid, empty model when metadata is unreachable', async () => {
    // A client whose every fetch rejects immediately (no real network → no hang).
    const failing = stubClient(() => Promise.reject(new Error('ECONNREFUSED')));
    const app = createBackendApi({ metadata: failing, cache, settingsStore: memStore() });
    const res = await app.request('/api/today');
    expect(res.status).toBe(200);
    const model = TodayResponseSchema.parse(await res.json()); // strict + body-free by construction
    expect(model.projectId).toBe('proj_1');
    expect(model.doNext).toEqual([]);
    expect(model.taskCounts).toEqual({ remaining: 0, done: 0 });
    expect(model.promiseMetrics.myPromises).toEqual({ total: 0, openCount: 0, overdueCount: 0 });
  });
});

describe('createBackendApi — inline actions are metadata-only (Phase 7a)', () => {
  const NOW = '2026-06-05T12:00:00.000Z';
  const task = {
    id: 'task1',
    thread_id: 'th1',
    state: 'needs-reply',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
  };

  /** Route the few calls the done/snooze endpoints make to canned responses. */
  function actionRouter(): FetchLike {
    return (url, init) => {
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'GET' && url.includes('/tasks')) return Promise.resolve(json([task]));
      if (method === 'POST' && url.includes('/transitions')) {
        return Promise.resolve(
          json(
            { id: 't1', task_id: 'task1', from: 'needs-reply', to: 'done', actor: 'me', at: NOW },
            201,
          ),
        );
      }
      if (method === 'PATCH' && url.includes('/tasks/task1')) {
        return Promise.resolve(json({ ...task, follow_up_at: '2026-06-09T09:00:00.000Z' }));
      }
      return Promise.resolve(json({ error: 'unexpected' }, 500));
    };
  }

  it('POST /api/tasks/:threadId/done transitions to done + broadcasts', async () => {
    const sent: WsMessage[] = [];
    const app = createBackendApi({
      metadata: stubClient(actionRouter()),
      cache,
      settingsStore: memStore(),
      broadcast: (msg) => sent.push(msg),
    });
    const res = await app.request('/api/tasks/th1/done', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as MarkDoneResponse).toEqual({
      threadId: 'th1',
      state: 'done',
      changed: true,
    });
    expect(sent).toEqual([{ type: 'today:changed' }]);
  });

  it('POST /api/tasks/:threadId/snooze sets follow_up_at + broadcasts', async () => {
    const sent: WsMessage[] = [];
    const app = createBackendApi({
      metadata: stubClient(actionRouter()),
      cache,
      settingsStore: memStore(),
      broadcast: (msg) => sent.push(msg),
    });
    const res = await app.request('/api/tasks/th1/snooze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ follow_up_at: '2026-06-09T09:00:00.000Z' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { follow_up_at: string }).follow_up_at).toBe(
      '2026-06-09T09:00:00.000Z',
    );
    expect(sent).toEqual([{ type: 'today:changed' }]);
  });
});
