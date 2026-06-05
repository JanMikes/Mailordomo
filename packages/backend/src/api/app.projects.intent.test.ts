/**
 * INTENT (separate test-author) — the Phase 7c (D32) ENDPOINTS through the REAL in-process metadata
 * server (NOT a hand-rolled stub): `GET /api/projects-board`, `GET /api/project`, and the `projectName`
 * enrichment on `GET /api/today` + `GET /api/threads/:id`. ADDITIVE to `app.projects.smoke.test.ts`
 * (which uses stubbed `fetch`).
 *
 * Why the real server: the `MetadataClient`'s `fetch` is the server's `app.fetch`, so every call
 * traverses real bearer auth + project scoping + strict shared-DTO validation on BOTH sides — exactly
 * production minus the socket. `PROJECT_A.name === 'Acme'`, so a successful `pair()` resolves that name.
 *
 * Derived from PROJECT.md §11 (board grouped by state; the never-trap fallback) + §6 (done exists) +
 * golden rule #3 (the board is body-free; `capturingFetch` proves no body crosses to the server). The
 * resolver's degradation is exercised against a `fetch` whose `/pair` is made to fail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  ProjectResponseSchema,
  ProjectsBoardResponseSchema,
  TASK_STATES,
  ThreadDetailSchema,
  TodayReadModelSchema,
} from '@mailordomo/shared';
import type { AppSettings } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import type { MetadataClient } from '../metadata-client';
import type { SettingsStore } from '../settings';
import {
  PROJECT_A,
  capturingFetch,
  startInProcessServer,
  type CapturedRequest,
  type InProcessServer,
} from '../integration/harness';
import { createBackendApi } from './app';

/** A tiny in-memory settings store (mirrors the smoke's helper) — keeps these tests file-local. */
function memSettingsStore(initial: AppSettings = { ...DEFAULT_APP_SETTINGS }): SettingsStore {
  let current = initial;
  return {
    read: () => current,
    write: (patch) => {
      current = AppSettingsSchema.parse({ ...current, ...patch });
      return current;
    },
  };
}

let server: InProcessServer;
let client: MetadataClient;
let cache: MessageCache;

beforeEach(() => {
  server = startInProcessServer(PROJECT_A);
  client = server.client(PROJECT_A);
  cache = MessageCache.open({ dbPath: ':memory:' });
});

afterEach(() => {
  server.close();
  cache.close();
});

function appWith(metadata: MetadataClient) {
  return createBackendApi({ metadata, cache, settingsStore: memSettingsStore() });
}

/**
 * Seed the real server with a thread per state + one task-less ("orphan") thread, so the board has a
 * thread in every group and the orphan exercises the never-lose rule. Returns the orphan's id.
 */
async function seedAllStates(c: MetadataClient): Promise<{ orphanId: string }> {
  let i = 0;
  for (const state of TASK_STATES) {
    const thread = await c.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: `<${state}@acme.com>`,
      subject: `Subject ${state}`,
      snippet: `snippet ${state}`,
      sender: 'Petr <petr@acme.com>',
      last_message_at: `2026-06-0${++i}T08:00:00.000Z`,
    });
    // createTask defaults to needs-reply; transition to the target state where it differs.
    const task = await c.createTask({ thread_id: thread.id, importance: 'normal' });
    if (state !== 'needs-reply') {
      await c.createTransition(task.id, { to: state, actor: 'jan' });
    }
  }
  const orphan = await c.upsertThread({
    project_id: PROJECT_A.id,
    mailbox_address: 'jan@acme.com',
    root_message_id: '<orphan@acme.com>',
    subject: 'Orphan subject',
    snippet: 'no task yet',
    sender: 'Lumír <lumir@acme.com>',
    last_message_at: '2026-06-09T08:00:00.000Z',
  });
  return { orphanId: orphan.id };
}

describe('GET /api/projects-board (D32) — real server, grouped by state', () => {
  it('groups every thread by its state, includes done, and never loses the task-less thread', async () => {
    const { orphanId } = await seedAllStates(client);
    const app = appWith(client);

    const res = await app.request('/api/projects-board');
    expect(res.status).toBe(200);
    const board = ProjectsBoardResponseSchema.parse(await res.json()); // strict + body-free
    const entry = board.projects[0];
    expect(entry?.projectId).toBe(PROJECT_A.id);
    expect(entry?.projectName).toBe('Acme'); // resolved via the real pair()

    // One real thread sits in each canonical state group; the orphan rides in needs-reply.
    for (const state of TASK_STATES) {
      const ids = entry?.groups[state].map((card) => card.threadId) ?? [];
      if (state === 'needs-reply') {
        expect(ids).toContain(orphanId);
        expect(ids.length).toBe(2); // the needs-reply thread + the orphan
      } else {
        expect(ids.length).toBe(1);
      }
    }
    expect(entry?.groups.done.length).toBe(1); // done is a real, populated group

    // The never-lose-a-thread invariant: 6 threads in, 6 cards out, none dropped.
    const total = TASK_STATES.reduce((sum, s) => sum + (entry?.counts[s] ?? 0), 0);
    expect(total).toBe(6);
  });

  it('renders the frame with empty groups + a null name when metadata is unreachable (never throws)', async () => {
    const failing = server.client(PROJECT_A, () => Promise.reject(new Error('ECONNREFUSED')));
    const app = appWith(failing);
    const res = await app.request('/api/projects-board');
    expect(res.status).toBe(200); // a never-trap escape hatch must still render its frame
    const board = ProjectsBoardResponseSchema.parse(await res.json());
    expect(board.projects[0]?.projectName).toBeNull();
    for (const state of TASK_STATES) expect(board.projects[0]?.counts[state]).toBe(0);
  });
});

describe('GET /api/project (D32) — real server', () => {
  it('returns the configured id + the resolved name', async () => {
    const app = appWith(client);
    const res = await app.request('/api/project');
    expect(res.status).toBe(200);
    expect(ProjectResponseSchema.parse(await res.json())).toEqual({
      id: PROJECT_A.id,
      name: 'Acme',
    });
  });
});

describe('projectName enrichment on Today + thread detail (D32)', () => {
  it('stamps the resolved name onto every do-next card', async () => {
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<n@acme.com>',
      subject: 'Needs a reply',
      snippet: 'please respond',
      sender: 'Petr <petr@acme.com>',
      last_message_at: '2026-06-05T08:00:00.000Z',
    });
    await client.createTask({ thread_id: thread.id, state: 'needs-reply', importance: 'normal' });
    const app = appWith(client);

    const model = TodayReadModelSchema.parse(await (await app.request('/api/today')).json());
    expect(model.doNext.length).toBeGreaterThan(0);
    for (const card of model.doNext) {
      expect(card.projectName).toBe('Acme');
      expect(card.projectId).toBe(PROJECT_A.id); // id still carried alongside
    }
  });

  it('carries the resolved name on the thread-detail read model', async () => {
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<d@acme.com>',
      subject: 'Detail thread',
      snippet: 'snippet',
      sender: 'Petr <petr@acme.com>',
      last_message_at: '2026-06-05T08:00:00.000Z',
    });
    const app = appWith(client);
    const res = await app.request(`/api/threads/${thread.id}`);
    expect(res.status).toBe(200);
    const detail = ThreadDetailSchema.parse(await res.json());
    expect(detail.projectName).toBe('Acme');
  });
});

describe('GOLDEN RULE #3 — assembling the board crosses NO body to the metadata server', () => {
  it('every outbound request body is body-free (and the deep-scan probe self-checks)', async () => {
    await seedAllStates(client);
    const cap = capturingFetch(server.fetch);
    const app = appWith(server.client(PROJECT_A, cap.fetch));

    await app.request('/api/projects-board');
    await app.request('/api/today');

    expect(cap.captured.length).toBeGreaterThan(0);
    const forbidden = ['body', 'draftBody', 'eml', 'html', 'content', 'text'];
    for (const req of cap.captured) carriesNoBody(req, forbidden);

    // Self-check the deep-scan BITES: a planted body key is detected.
    expect(() =>
      carriesNoBody(
        { method: 'POST', path: '/x', body: { body: 'leak' }, rawBody: '{}' },
        forbidden,
      ),
    ).toThrow();
  });
});

/** Assert a captured request body has none of `forbidden` keys at any depth (recursive deep-scan). */
function carriesNoBody(req: CapturedRequest, forbidden: readonly string[]): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.includes(key)) {
          throw new Error(`forbidden key "${key}" in ${req.method} ${req.path}`);
        }
        walk(child);
      }
    }
  };
  walk(req.body);
}
