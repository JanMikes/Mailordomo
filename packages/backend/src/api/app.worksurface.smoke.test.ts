/**
 * Smoke tests for the Phase 7b split-work-surface endpoints (D31). Everything is in-process: an
 * in-memory cache, a FAKE Claude runner, an in-memory draft store, a STUB mail transport, and a
 * MetadataClient whose `fetch` is a canned + capturing router. The exhaustive intent-derived suite is
 * the separate test-author's job — this proves the endpoints wire and uphold the golden rules:
 *  - #1 manual send: `POST …/send` is the only transmission and it hits the STUB transport.
 *  - #3 bodies never leave: a draft body never appears in the captured `createDraftMeta` request.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, LearningEntry } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS, ThreadDetailSchema } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { FakeClaudeRunner } from '../claude';
import { createMemoryDraftStore } from '../drafts';
import type { DraftStore } from '../drafts';
import { LearningLog } from '../learning';
import { MetadataClient } from '../metadata-client';
import type { FetchLike } from '../metadata-client';
import type { SettingsStore } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import { createStubMailTransport } from '../smtp/stub-transport';
import type { StubMailTransport } from '../smtp/stub-transport';
import { ToneStore } from '../tone';
import type { BackendApiDeps, DraftResponse, MessageBodyResponse, SendResponse } from './app';
import { createBackendApi } from './app';

const NOW = '2026-06-06T10:00:00.000Z';

const THREAD = {
  id: 'th1',
  project_id: 'proj_1',
  mailbox_address: 'me@example.com',
  root_message_id: '<root@example.com>',
  subject: 'Invoice question',
  snippet: 'Can you clarify the invoice?',
  sender: 'Client <client@acme.com>',
  last_message_at: '2026-06-05T09:00:00.000Z',
  updated_at: '2026-06-05T09:00:00.000Z',
};
const TASK = {
  id: 'task1',
  thread_id: 'th1',
  state: 'needs-reply',
  deadline: null,
  follow_up_at: null,
  importance: 'high',
  updated_at: NOW,
};
const TRANSITION = {
  id: 'tr1',
  task_id: 'task1',
  from: 'needs-reply',
  to: 'waiting',
  actor: 'me',
  at: NOW,
};
const DRAFT_META = {
  id: 'dm1',
  thread_id: 'th1',
  version: 1,
  model: 'opus',
  author: 'claude',
  at: NOW,
};
const LOCK = {
  thread_id: 'th1',
  locked_by: 'me',
  locked_at: NOW,
  expires_at: '2026-06-06T10:30:00.000Z',
};

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A capturing + canned metadata router covering the calls the work-surface endpoints make. */
function makeMetadata(
  captured: Captured[],
  extra?: (method: string, url: string) => Response | undefined,
): MetadataClient {
  const fetchImpl: FetchLike = (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    captured.push({ method, url, body });
    const json = (data: unknown, status = 200): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const overridden = extra?.(method, url);
    if (overridden !== undefined) return Promise.resolve(overridden);
    if (method === 'GET' && url.endsWith('/threads/th1')) return json(THREAD);
    if (method === 'GET' && url.endsWith('/locks')) return json([]);
    if (method === 'GET' && url.includes('/tasks')) return json([TASK]);
    if (method === 'POST' && url.includes('/transitions')) return json(TRANSITION, 201);
    if (method === 'POST' && url.endsWith('/drafts')) return json(DRAFT_META, 201);
    if (method === 'POST' && url.endsWith('/locks/acquire'))
      return json({ acquired: true, lock: LOCK });
    if (method === 'POST' && url.endsWith('/locks/release')) return json({ released: true });
    if (method === 'GET' && url.endsWith('/learning')) return json([]);
    return json({ error: `unexpected ${method} ${url}` }, 500);
  };
  return new MetadataClient({
    baseUrl: 'http://metadata.local',
    projectId: 'proj_1',
    token: 't',
    fetch: fetchImpl,
  });
}

function memSettings(initial: AppSettings = { ...DEFAULT_APP_SETTINGS }): SettingsStore {
  let current = initial;
  return {
    read: () => current,
    write: (patch) => {
      current = AppSettingsSchema.parse({ ...current, ...patch });
      return current;
    },
  };
}

let cache: MessageCache;
let captured: Captured[];
let stub: StubMailTransport;
let draftStore: DraftStore;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
  captured = [];
  stub = createStubMailTransport();
  draftStore = createMemoryDraftStore();
});

afterEach(() => {
  cache.close();
});

/** Build the app with the full 7b dep set (overridable). */
function makeApi(overrides: Partial<BackendApiDeps> = {}): ReturnType<typeof createBackendApi> {
  const runner = new FakeClaudeRunner({
    byKind: {
      draft: (spec) => ({
        text: spec.prompt.includes('Now revise') ? 'REFINED BODY' : 'DRAFT BODY',
      }),
      summarize: { text: 'PINNED SUMMARY' },
    },
  });
  return createBackendApi({
    metadata: makeMetadata(captured),
    cache,
    settingsStore: memSettings(),
    runner,
    draftStore,
    sendDeps: { composer: createNodemailerComposer(), transport: stub },
    ...overrides,
  });
}

describe('GET /api/threads/:threadId — body-free detail', () => {
  it('assembles a strict, body-free ThreadDetail', async () => {
    const app = makeApi();
    const res = await app.request('/api/threads/th1');
    expect(res.status).toBe(200);
    const detail = ThreadDetailSchema.parse(await res.json()); // strict + body-free by construction
    expect(detail.threadId).toBe('th1');
    expect(detail.subject).toBe('Invoice question');
    expect(detail.sender).toBe('Client <client@acme.com>');
    expect(detail.lock).toBeNull();
    expect(detail.messages).toEqual([]); // empty cache → no message slice
  });

  it('surfaces cached messages + a pinned summary when the cache has the thread', async () => {
    const folder = cache.upsertFolderMeta({
      mailboxAddress: 'me@example.com',
      path: 'INBOX',
      uidValidity: '1',
    });
    const rowId = cache.upsertMessage({
      folderId: folder.id,
      uid: 1,
      uidValidity: '1',
      messageId: '<root@example.com>',
      subject: 'Invoice question',
      sender: 'Client <client@acme.com>',
      snippet: 'Can you clarify?',
      internalDate: '2026-06-05T09:00:00.000Z',
    });
    cache.setThreadRoot(rowId, '<root@example.com>');

    const res = await makeApi().request('/api/threads/th1');
    const detail = ThreadDetailSchema.parse(await res.json());
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]?.messageId).toBe('<root@example.com>');
    expect('body' in (detail.messages[0] ?? {})).toBe(false); // body-free
    expect(detail.pinnedSummary).toBe('PINNED SUMMARY');
  });

  it('404s when neither metadata nor cache knows the thread', async () => {
    const app = makeApi({
      metadata: makeMetadata(captured, (method, url) =>
        method === 'GET' && url.endsWith('/threads/ghost')
          ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
          : undefined,
      ),
    });
    const res = await app.request('/api/threads/ghost');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/threads/:threadId/messages/:messageId/body — LOCAL only', () => {
  it('parses the rendered text from the on-disk .eml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-eml-'));
    try {
      const emlPath = join(dir, 'msg.eml');
      writeFileSync(emlPath, 'From: a@b\r\nTo: c@d\r\nSubject: Hi\r\n\r\nHello world body.\r\n');
      const folder = cache.upsertFolderMeta({
        mailboxAddress: 'me@example.com',
        path: 'INBOX',
        uidValidity: '1',
      });
      cache.upsertMessage({
        folderId: folder.id,
        uid: 1,
        uidValidity: '1',
        messageId: '<m1@example.com>',
        emlPath,
      });
      const res = await makeApi().request(
        `/api/threads/th1/messages/${encodeURIComponent('<m1@example.com>')}/body`,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as MessageBodyResponse).body).toContain('Hello world body.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s when the message is not cached', async () => {
    const res = await makeApi().request(
      `/api/threads/th1/messages/${encodeURIComponent('<absent@x>')}/body`,
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/threads/:threadId/draft — generate (body LOCAL, meta only on server)', () => {
  it('returns the draft, persists it locally, and records body-free DraftMeta', async () => {
    const app = makeApi();
    const res = await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    expect(res.status).toBe(200);
    const draft = (await res.json()) as DraftResponse;
    expect(draft.body).toBe('DRAFT BODY');
    expect(draft.model).toBe('opus');
    expect(draft.version).toBe(1);
    expect(draft.transcript).toEqual([
      { role: 'user', content: 'be brief' },
      { role: 'assistant', content: 'DRAFT BODY' },
    ]);
    // The body is persisted LOCALLY...
    expect(draftStore.getDraft('th1')?.body).toBe('DRAFT BODY');
    // ...and the DraftMeta sent to the server carries NO body (golden rule #3).
    const draftMetaReq = captured.find((c) => c.method === 'POST' && c.url.endsWith('/drafts'));
    expect(draftMetaReq?.body).toEqual({
      thread_id: 'th1',
      version: 1,
      model: 'opus',
      author: 'claude',
    });
    expect('body' in (draftMetaReq?.body as object)).toBe(false);
    expect('draftBody' in (draftMetaReq?.body as object)).toBe(false);
  });

  it('503s when drafting is not configured', async () => {
    const app = makeApi({ runner: undefined, draftStore: undefined });
    const res = await app.request('/api/threads/th1/draft', { method: 'POST' });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/threads/:threadId/draft/refine — replay + bump', () => {
  it('refines an existing draft and bumps the version', async () => {
    const app = makeApi();
    await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    const res = await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'make it warmer' }),
    });
    expect(res.status).toBe(200);
    const draft = (await res.json()) as DraftResponse;
    expect(draft.body).toBe('REFINED BODY');
    expect(draft.version).toBe(2);
    expect(draft.transcript).toHaveLength(4);
    expect(draft.transcript[2]).toEqual({ role: 'user', content: 'make it warmer' });
  });

  it('404s when there is no draft to refine; 400 without an instruction', async () => {
    const app = makeApi();
    const noDraft = await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'x' }),
    });
    expect(noDraft.status).toBe(404);

    draftStore.saveDraft('th1', { body: 'b', model: 'opus', author: 'claude', transcript: [] });
    const noInstruction = await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noInstruction.status).toBe(400);
  });
});

describe('GET /api/threads/:threadId/draft', () => {
  it('returns the current local draft', async () => {
    draftStore.saveDraft('th1', {
      body: 'saved body',
      model: 'opus',
      author: 'claude',
      transcript: [{ role: 'user', content: 'hi' }],
    });
    const res = await makeApi().request('/api/threads/th1/draft');
    expect(res.status).toBe(200);
    expect(((await res.json()) as DraftResponse).body).toBe('saved body');
  });

  it('404s when no draft exists', async () => {
    const res = await makeApi().request('/api/threads/th1/draft');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/threads/:threadId/send — MANUAL SEND (golden rule #1)', () => {
  it('sends via the STUB transport, transitions to waiting, and clears the draft', async () => {
    draftStore.saveDraft('th1', {
      body: 'DRAFT BODY',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    const app = makeApi();
    const res = await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'EDITED FINAL BODY' }),
    });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as SendResponse;
    expect(sent.state).toBe('waiting');
    expect(typeof sent.messageId).toBe('string');
    expect(sent.filedTo).toBeNull(); // no IMAP creds yet → no Sent append

    // The STUB transport recorded EXACTLY one send — nothing ever hit the network.
    expect(stub.sent).toHaveLength(1);
    // The task was transitioned (metadata write, never a send).
    expect(captured.some((c) => c.method === 'POST' && c.url.includes('/transitions'))).toBe(true);
    // The local draft was cleared.
    expect(draftStore.getDraft('th1')).toBeUndefined();
  });

  it('503s when send is not configured (no path exists at all)', async () => {
    const app = makeApi({ sendDeps: undefined });
    const res = await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(503);
    expect(stub.sent).toHaveLength(0);
  });

  it('400s without a body (never composes / sends)', async () => {
    const app = makeApi();
    const res = await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(stub.sent).toHaveLength(0);
  });
});

describe('POST /api/threads/:threadId/lock/* — presence', () => {
  it('acquire sends the settings-derived ttl_seconds + the local actor', async () => {
    const app = makeApi({
      settingsStore: memSettings({ ...DEFAULT_APP_SETTINGS, lockTimeoutMinutes: 30 }),
    });
    const res = await app.request('/api/threads/th1/lock/acquire', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { acquired: boolean }).toEqual({ acquired: true, lock: LOCK });
    const acquire = captured.find((c) => c.url.endsWith('/locks/acquire'));
    expect(acquire?.body).toEqual({ thread_id: 'th1', locked_by: 'me', ttl_seconds: 1800 });
  });

  it('release wraps releaseLock', async () => {
    const res = await makeApi().request('/api/threads/th1/lock/release', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { released: boolean }).toEqual({ released: true });
  });
});

describe('POST /api/learning/:id/revert — D28 LIFO guard (server-side)', () => {
  let logDir: string;
  let toneDir: string;
  let learningLog: LearningLog;
  let toneStore: ToneStore;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'mailordomo-learn-'));
    toneDir = mkdtempSync(join(tmpdir(), 'mailordomo-tone-'));
    learningLog = LearningLog.open({ dir: logDir });
    toneStore = ToneStore.open({ dir: toneDir, projectId: 'proj_1' });
    const base = {
      project_id: 'proj_1' as const,
      scope: 'contact' as const,
      path: 'contact/x.md',
      before_content: 'OLD',
      after_content: 'NEW',
      reverted_at: null,
    };
    learningLog.append({
      ...base,
      id: 'l1',
      summary: 'older lesson',
      applied_at: '2026-06-06T08:00:00.000Z',
    });
    learningLog.append({
      ...base,
      id: 'l2',
      summary: 'newer lesson',
      applied_at: '2026-06-06T09:00:00.000Z',
    });
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    rmSync(toneDir, { recursive: true, force: true });
  });

  function api(): ReturnType<typeof createBackendApi> {
    const revertEntry: LearningEntry = {
      id: 'l2',
      project_id: 'proj_1',
      scope: 'contact',
      summary: 'newer lesson',
      applied_at: '2026-06-06T09:00:00.000Z',
      reverted_at: NOW,
    };
    return makeApi({
      learningLog,
      toneStore,
      metadata: makeMetadata(captured, (method, url) =>
        method === 'POST' && url.endsWith('/learning/l2/revert')
          ? new Response(JSON.stringify(revertEntry), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      ),
    });
  }

  it('refuses to revert an older entry while a newer one for the same file is un-reverted', async () => {
    const res = await api().request('/api/learning/l1/revert', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(learningLog.get('l1')?.reverted_at).toBeNull(); // untouched
  });

  it('reverts the most-recent un-reverted entry', async () => {
    const res = await api().request('/api/learning/l2/revert', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(learningLog.get('l2')?.reverted_at).not.toBeNull();
  });

  it('404s for an entry with no local snapshot', async () => {
    const res = await api().request('/api/learning/unknown/revert', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
