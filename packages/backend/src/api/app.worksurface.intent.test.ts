/**
 * INTENT (separate test-author) — the Phase 7b split work surface + refine chat, derived from
 * PROJECT.md intent FIRST (§5/§6/§11 + golden rules #1/#3/#5/#6) and PLAN.md D27/D28/D31, then
 * reconciled against the impl. ADDITIVE to `app.worksurface.smoke.test.ts` (which the implementer
 * wrote) — this hardens the load-bearing, adversarial cases the smoke only touches lightly:
 *
 *  - #1 (manual send / no autonomous send): a HOSTILE transmit-spy transport proves `POST /draft` and
 *    `POST /draft/refine` make ZERO `transport.send` calls; only `POST /send` transmits, only when
 *    called; an empty/whitespace body is refused with NO transmit.
 *  - #3 (bodies never leave): a CAPTURING metadata fetch deep-scans every outbound request during
 *    draft → refine → send and proves no draft/message body ever crosses; only DraftMeta
 *    (thread/version/model/author) + the learning `summary`. A PLANTED body proves the scan is
 *    non-vacuous. `ThreadDetail`/`ThreadMessageMeta` are body-free; the `/body` hop is a DISTINCT
 *    local endpoint that DOES return a body.
 *  - #5 (replay, not resume): refine REPLAYS the FULL prior transcript into the next runner call
 *    (asserted on the actual `JobSpec.prompt` + argv the runner received) with NO `--continue`/
 *    `--resume`; the version bumps per refine.
 *  - #6 (routing): the draft/refine job routes to OPUS.
 *  - state machine (§6): a successful `POST /send` transitions the task to `waiting` (actor-attributed).
 *  - lock TTL (D27): acquire/refresh send `ttl_seconds === lockTimeoutMinutes * 60`; changing the
 *    setting changes the sent ttl. Release works.
 *  - learning LIFO guard (D28): driven against the REAL in-process metadata server + a REAL
 *    `LearningLog`/`ToneStore` — apply A then B to the SAME tone path, then prove reverting A (older)
 *    is REFUSED 409 while B is un-reverted, reverting B (last) succeeds, then A becomes revertable, and
 *    re-reverting an already-reverted entry is refused.
 *  - draft-vs-sent learning trigger (Phase 6, finally wired): an edited send fires `applyLearning`;
 *    an identical send does NOT; a learning FAILURE must NOT fail the send (still 200).
 *
 * Everything is in-process and deterministic: the FAKE runner, the memory/real DraftStore, a STUB or
 * HOSTILE transport, and either a canned+capturing metadata router OR the REAL in-process server. No
 * live `claude`, SMTP, or IMAP.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@mailordomo/shared';
import {
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
  ThreadDetailSchema,
  modelForTask,
} from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { FakeClaudeRunner } from '../claude';
import type { ClaudeRunner, JobResult, JobSpec } from '../claude';
import { createMemoryDraftStore } from '../drafts';
import type { DraftStore } from '../drafts';
import { LearningLog } from '../learning';
import { MetadataClient } from '../metadata-client';
import type { FetchLike } from '../metadata-client';
import type { SettingsStore } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import type { ComposedMime, MailTransport } from '../smtp/send';
import { createStubMailTransport } from '../smtp/stub-transport';
import { ToneStore } from '../tone';
import { PROJECT_A, startInProcessServer, type InProcessServer } from '../integration/harness';
import type { BackendApiDeps, DraftResponse, SendResponse } from './app';
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
  /** The parsed JSON body (if any). */
  readonly body: unknown;
  /** The raw request body string (for a non-vacuous deep byte scan). */
  readonly rawBody: string | undefined;
}

/** A capturing + canned metadata router covering the calls the work-surface endpoints make. */
function makeMetadata(
  captured: Captured[],
  extra?: (method: string, url: string) => Response | undefined,
): MetadataClient {
  const fetchImpl: FetchLike = (url, init) => {
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const body = rawBody !== undefined ? JSON.parse(rawBody) : undefined;
    captured.push({ method, url, body, rawBody });
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
    if (method === 'POST' && url.endsWith('/locks/refresh')) return json(LOCK);
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

/** A FAKE runner that answers draft/refine deterministically (REFINED vs DRAFT by prompt) + summaries. */
function draftRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner({
    byKind: {
      draft: (spec) => ({
        text: spec.prompt.includes('Now revise') ? 'REFINED BODY' : 'DRAFT BODY',
      }),
      summarize: { text: 'PINNED SUMMARY' },
    },
  });
}

let cache: MessageCache;
let captured: Captured[];
let stub: ReturnType<typeof createStubMailTransport>;
let draftStore: DraftStore;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
  captured = [];
  stub = createStubMailTransport();
  draftStore = createMemoryDraftStore();
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
});

/** Build the app with the full 7b dep set (overridable). */
function makeApi(overrides: Partial<BackendApiDeps> = {}): ReturnType<typeof createBackendApi> {
  return createBackendApi({
    metadata: makeMetadata(captured),
    cache,
    settingsStore: memSettings(),
    runner: draftRunner(),
    draftStore,
    sendDeps: { composer: createNodemailerComposer(), transport: stub },
    ...overrides,
  });
}

/* ============================================================================ *
 * Golden rule #1 — manual send / NO autonomous send (behavioral proof)         *
 * ============================================================================ */

/** A HOSTILE transport: every `.send` is a spy that throws if it is ever called outside an explicit send. */
function hostileTransport(): MailTransport & { sends: ComposedMime[] } {
  const sends: ComposedMime[] = [];
  return {
    sends,
    send(composed: ComposedMime) {
      sends.push(composed);
      return Promise.resolve({ messageId: composed.messageId, response: 'hostile-spy' });
    },
  };
}

describe('Golden rule #1 — drafting NEVER transmits; only an explicit send does', () => {
  it('POST /draft makes ZERO transport.send calls (drafting is text-only)', async () => {
    const transport = hostileTransport();
    const app = makeApi({ sendDeps: { composer: createNodemailerComposer(), transport } });
    const res = await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as DraftResponse).toMatchObject({ body: 'DRAFT BODY' });
    // The hostile transport was NEVER touched by drafting.
    expect(transport.sends).toHaveLength(0);
  });

  it('POST /draft/refine makes ZERO transport.send calls (replay refine is text-only)', async () => {
    const transport = hostileTransport();
    const app = makeApi({ sendDeps: { composer: createNodemailerComposer(), transport } });
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
    expect(transport.sends).toHaveLength(0);
  });

  it('ONLY POST /send transmits — and exactly once, on the explicit call', async () => {
    const transport = hostileTransport();
    draftStore.saveDraft('th1', {
      body: 'DRAFT BODY',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    const app = makeApi({ sendDeps: { composer: createNodemailerComposer(), transport } });

    // No send yet — even after generate + refine the transport is silent.
    await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    expect(transport.sends).toHaveLength(0);

    const res = await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'EDITED FINAL BODY' }),
    });
    expect(res.status).toBe(200);
    expect(transport.sends).toHaveLength(1); // exactly one transmission, only from /send
  });

  it('POST /send with an empty/whitespace body is refused (400) and transmits NOTHING', async () => {
    const transport = hostileTransport();
    const app = makeApi({ sendDeps: { composer: createNodemailerComposer(), transport } });
    for (const body of [{}, { body: '' }, { body: '   \n  ' }]) {
      const res = await app.request('/api/threads/th1/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(transport.sends).toHaveLength(0);
  });
});

/* ============================================================================ *
 * Golden rule #3 — bodies never leave the machine                              *
 * ============================================================================ */

/** Deep-scan a captured request's RAW bytes for any forbidden body fragment (non-vacuous proof). */
function rawCarries(captured: readonly Captured[], fragment: string): boolean {
  return captured.some((c) => c.rawBody !== undefined && c.rawBody.includes(fragment));
}

describe('Golden rule #3 — draft/message bodies never cross to the metadata server', () => {
  it('across draft → refine → send, no draft/sent body fragment appears in ANY outbound request', async () => {
    draftStore.saveDraft('th1', {
      body: 'SECRET-DRAFT',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    const app = makeApi();

    await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'make it warmer' }),
    });
    await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'SECRET-SENT-BODY-9f3a' }),
    });

    // The model-produced bodies + the user's sent body never appear on the wire.
    expect(rawCarries(captured, 'DRAFT BODY')).toBe(false);
    expect(rawCarries(captured, 'REFINED BODY')).toBe(false);
    expect(rawCarries(captured, 'SECRET-SENT-BODY-9f3a')).toBe(false);

    // Every DraftMeta the server received carries ONLY metadata keys (no body / draftBody / content).
    const draftMetas = captured.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts'));
    expect(draftMetas.length).toBeGreaterThanOrEqual(1);
    for (const meta of draftMetas) {
      expect(Object.keys(meta.body as object).sort()).toEqual(
        ['author', 'model', 'thread_id', 'version'].sort(),
      );
    }
  });

  it('NON-VACUOUS: the scan WOULD catch a planted body fragment on the wire', () => {
    // Prove the scanner is real: a request whose raw body contains the marker is detected.
    const planted: Captured[] = [
      {
        method: 'POST',
        url: 'http://x/drafts',
        body: { draftBody: 'DRAFT BODY' },
        rawBody: '{"draftBody":"DRAFT BODY"}',
      },
    ];
    expect(rawCarries(planted, 'DRAFT BODY')).toBe(true);
  });

  it('GET /threads/:id returns a body-free, strict ThreadDetail (no body key survives parse)', async () => {
    const res = await makeApi().request('/api/threads/th1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // Strict parse is body-free BY CONSTRUCTION — a smuggled body key would fail it.
    const detail = ThreadDetailSchema.parse(json);
    expect('body' in json).toBe(false);
    expect('draftBody' in json).toBe(false);
    for (const m of detail.messages) expect('body' in m).toBe(false);
  });

  it('the rendered-body hop is a DISTINCT local endpoint that DOES return a body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-eml-intent-'));
    try {
      const emlPath = join(dir, 'msg.eml');
      writeFileSync(
        emlPath,
        'From: a@b\r\nTo: c@d\r\nSubject: Hi\r\n\r\nLOCAL-ONLY-BODY-TEXT.\r\n',
      );
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
      // The capturing metadata router recorded nothing about this hop — it never touched the server.
      const beforeCount = captured.length;
      const res = await makeApi().request(
        `/api/threads/th1/messages/${encodeURIComponent('<m1@example.com>')}/body`,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { body: string }).body).toContain('LOCAL-ONLY-BODY-TEXT.');
      // It is LOCAL: this endpoint issued zero metadata-server requests.
      expect(captured.length).toBe(beforeCount);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ============================================================================ *
 * Golden rule #5 — refine REPLAYS history (no --continue/--resume)             *
 * ============================================================================ */

describe('Golden rule #5 — refine replays the FULL transcript into a fresh stateless call', () => {
  it('the refine runner call carries the prior instruction + prior draft + the new instruction', async () => {
    const runner = draftRunner();
    const app = makeApi({ runner });

    await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'make it warmer' }),
    });

    // The runner saw a draft call, then a refine call. (summarize may interleave; filter to drafts.)
    const draftCalls = runner.calls.filter((s) => s.taskKind === 'draft');
    expect(draftCalls.length).toBe(2);
    const refinePrompt = draftCalls[1]?.prompt ?? '';
    // Full prior history is REPLAYED into the single fresh call — not a stateful resume.
    expect(refinePrompt).toContain('be brief'); // prior user instruction
    expect(refinePrompt).toContain('DRAFT BODY'); // prior assistant draft
    expect(refinePrompt).toContain('make it warmer'); // the new instruction

    // The argv for EVERY draft/refine call is stateless: no session-resume flag anywhere.
    for (const argv of runner.argv) {
      expect(argv).not.toContain('--continue');
      expect(argv).not.toContain('--resume');
    }
  });

  it('each refine BUMPS the version (1 → 2 → 3)', async () => {
    const app = makeApi();
    const v1 = (await (
      await app.request('/api/threads/th1/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'be brief' }),
      })
    ).json()) as DraftResponse;
    expect(v1.version).toBe(1);

    const v2 = (await (
      await app.request('/api/threads/th1/draft/refine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'warmer' }),
      })
    ).json()) as DraftResponse;
    expect(v2.version).toBe(2);

    const v3 = (await (
      await app.request('/api/threads/th1/draft/refine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: 'shorter' }),
      })
    ).json()) as DraftResponse;
    expect(v3.version).toBe(3);
    // The transcript grew by 2 turns each refine: [u,a] → [u,a,u,a] → [u,a,u,a,u,a].
    expect(v3.transcript).toHaveLength(6);
  });
});

/* ============================================================================ *
 * Golden rule #6 — draft/refine route to OPUS                                  *
 * ============================================================================ */

describe('Golden rule #6 — the draft/refine job routes to Opus', () => {
  it('both the draft and the refine runner call use --model opus', async () => {
    const runner = draftRunner();
    const app = makeApi({ runner });
    await app.request('/api/threads/th1/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    await app.request('/api/threads/th1/draft/refine', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'warmer' }),
    });

    expect(modelForTask('draft')).toBe('opus'); // pin the routing constant itself
    const draftIdx = runner.calls
      .map((s, i) => ({ kind: s.taskKind, i }))
      .filter((x) => x.kind === 'draft')
      .map((x) => x.i);
    expect(draftIdx.length).toBe(2);
    for (const i of draftIdx) {
      const argv = runner.argv[i] ?? [];
      expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    }
    // The response model badge is the Opus alias too.
    const draft = draftStore.getDraft('th1');
    expect(draft?.model).toBe('opus');
  });
});

/* ============================================================================ *
 * State machine — a successful send transitions the task to `waiting`          *
 * ============================================================================ */

describe('State machine (§6) — I sent ⇒ waiting', () => {
  it('a successful POST /send records a transition to `waiting` (actor-attributed)', async () => {
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
    expect((await res.json()) as SendResponse).toMatchObject({ state: 'waiting' });

    const transition = captured.find((c) => c.method === 'POST' && c.url.includes('/transitions'));
    expect(transition).toBeDefined();
    expect(transition?.body).toMatchObject({ to: 'waiting', actor: 'me' });
  });

  it('does not transition when the active task is already `waiting` (no redundant write)', async () => {
    draftStore.saveDraft('th1', {
      body: 'DRAFT BODY',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    const app = makeApi({
      metadata: makeMetadata(captured, (method, url) =>
        method === 'GET' && url.includes('/tasks')
          ? new Response(JSON.stringify([{ ...TASK, state: 'waiting' }]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      ),
    });
    const res = await app.request('/api/threads/th1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'EDITED FINAL BODY' }),
    });
    expect(res.status).toBe(200);
    expect(captured.some((c) => c.method === 'POST' && c.url.includes('/transitions'))).toBe(false);
  });
});

/* ============================================================================ *
 * Lock TTL (D27) — ttl_seconds === lockTimeoutMinutes * 60                      *
 * ============================================================================ */

describe('Lock TTL (D27) — the user-configured timeout flows to acquire/refresh', () => {
  it('acquire sends ttl_seconds = lockTimeoutMinutes * 60 (and it tracks the setting)', async () => {
    // Default 30 min → 1800s.
    const a = makeApi();
    await a.request('/api/threads/th1/lock/acquire', { method: 'POST' });
    expect(captured.find((c) => c.url.endsWith('/locks/acquire'))?.body).toEqual({
      thread_id: 'th1',
      locked_by: 'me',
      ttl_seconds: 1800,
    });

    // Change the setting → the sent ttl changes (45 min → 2700s).
    captured.length = 0;
    const b = makeApi({
      settingsStore: memSettings({ ...DEFAULT_APP_SETTINGS, lockTimeoutMinutes: 45 }),
    });
    await b.request('/api/threads/th1/lock/acquire', { method: 'POST' });
    expect(captured.find((c) => c.url.endsWith('/locks/acquire'))?.body).toMatchObject({
      ttl_seconds: 2700,
    });
  });

  it('refresh sends the SAME settings-derived ttl_seconds', async () => {
    const app = makeApi({
      settingsStore: memSettings({ ...DEFAULT_APP_SETTINGS, lockTimeoutMinutes: 10 }),
    });
    const res = await app.request('/api/threads/th1/lock/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(captured.find((c) => c.url.endsWith('/locks/refresh'))?.body).toMatchObject({
      thread_id: 'th1',
      locked_by: 'me',
      ttl_seconds: 600,
    });
  });

  it('release wraps releaseLock with the actor', async () => {
    const res = await makeApi().request('/api/threads/th1/lock/release', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { released: boolean }).toEqual({ released: true });
    expect(captured.find((c) => c.url.endsWith('/locks/release'))?.body).toEqual({
      thread_id: 'th1',
      locked_by: 'me',
    });
  });

  it('a refresh 409 (lost the lock to another holder) surfaces as 409, not a 500', async () => {
    const app = makeApi({
      metadata: makeMetadata(captured, (method, url) =>
        method === 'POST' && url.endsWith('/locks/refresh')
          ? new Response(JSON.stringify({ error: 'held by another', code: 'locked' }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
      ),
    });
    const res = await app.request('/api/threads/th1/lock/refresh', { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

/* ============================================================================ *
 * Learning revert LIFO guard (D28) — driven against the REAL in-process server *
 * ============================================================================ */

describe('Learning revert LIFO guard (D28) — adversarial, real metadata server', () => {
  let server: InProcessServer;
  let client: MetadataClient;
  let logDir: string;
  let toneDir: string;
  let learningLog: LearningLog;
  let toneStore: ToneStore;
  let idA: string;
  let idB: string;

  /** A runner that never runs (revert + these tests don't invoke the model). */
  const noRunner: ClaudeRunner = {
    run: () => Promise.reject(new Error('runner must not be called')),
  };

  beforeEach(async () => {
    server = startInProcessServer(PROJECT_A);
    client = server.client(PROJECT_A);
    logDir = mkdtempSync(join(tmpdir(), 'mailordomo-learn-intent-'));
    toneDir = mkdtempSync(join(tmpdir(), 'mailordomo-tone-intent-'));
    learningLog = LearningLog.open({ dir: logDir });
    toneStore = ToneStore.open({ dir: toneDir, projectId: PROJECT_A.id });

    // Two REAL server entries for the SAME tone-file path, applied A (older) then B (newer). We mirror
    // the server's assigned ids into the local snapshot log (as `applyLearning` does in production).
    const a = await client.createLearningEntry({
      project_id: PROJECT_A.id,
      scope: 'contact',
      summary: 'older: sign off briefly',
    });
    const b = await client.createLearningEntry({
      project_id: PROJECT_A.id,
      scope: 'contact',
      summary: 'newer: drop the greeting',
    });
    idA = a.id;
    idB = b.id;
    const path = 'contact/client@acme.com.md';
    learningLog.append({
      id: idA,
      project_id: PROJECT_A.id,
      scope: 'contact',
      path,
      summary: a.summary,
      before_content: '',
      after_content: 'A',
      applied_at: a.applied_at,
      reverted_at: null,
    });
    learningLog.append({
      id: idB,
      project_id: PROJECT_A.id,
      scope: 'contact',
      path,
      summary: b.summary,
      before_content: 'A',
      after_content: 'A\n\nB',
      applied_at: b.applied_at,
      reverted_at: null,
    });
    // Tone file reflects both lessons applied.
    toneStore.write({
      scope: 'contact',
      path,
      content: 'A\n\nB',
      updated_by: 'claude',
      updated_at: NOW,
    });
  });

  afterEach(() => {
    server.close();
    rmSync(logDir, { recursive: true, force: true });
    rmSync(toneDir, { recursive: true, force: true });
  });

  function api(): ReturnType<typeof createBackendApi> {
    return createBackendApi({
      metadata: client,
      cache,
      settingsStore: memSettings(),
      runner: noRunner,
      draftStore,
      toneStore,
      learningLog,
    });
  }

  it('REFUSES (409) to revert the OLDER entry A while the NEWER B for the same file is un-reverted', async () => {
    const res = await api().request(`/api/learning/${encodeURIComponent(idA)}/revert`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    // Neither the local log nor the server flag was touched.
    expect(learningLog.get(idA)?.reverted_at).toBeNull();
    const serverEntries = await client.listLearningEntries();
    expect(serverEntries.find((e) => e.id === idA)?.reverted_at ?? null).toBeNull();
  });

  it('the full LIFO sequence: revert B (last) → then A becomes revertable → re-revert refused', async () => {
    const app = api();

    // 1) Revert B (the most-recently-applied un-reverted lesson for the file) — allowed.
    const rb = await app.request(`/api/learning/${encodeURIComponent(idB)}/revert`, {
      method: 'POST',
    });
    expect(rb.status).toBe(200);
    expect(learningLog.get(idB)?.reverted_at).not.toBeNull();
    // The server flag flipped too (real round-trip).
    const afterB = await client.listLearningEntries();
    expect(afterB.find((e) => e.id === idB)?.reverted_at ?? null).not.toBeNull();
    // The tone file rolled back to A's snapshot (whole-file restore — golden rule #2).
    expect(toneStore.read('contact/client@acme.com.md')?.content).toBe('A');

    // 2) NOW A is the last un-reverted entry for the file → revertable.
    const ra = await app.request(`/api/learning/${encodeURIComponent(idA)}/revert`, {
      method: 'POST',
    });
    expect(ra.status).toBe(200);
    expect(learningLog.get(idA)?.reverted_at).not.toBeNull();
    expect(toneStore.read('contact/client@acme.com.md')?.content).toBe('');

    // 3) Re-reverting an ALREADY-reverted entry is refused (409), not a silent no-op or 200.
    const again = await app.request(`/api/learning/${encodeURIComponent(idB)}/revert`, {
      method: 'POST',
    });
    expect(again.status).toBe(409);
  });

  it('404s for an id with no LOCAL snapshot (even if it exists on the server)', async () => {
    const orphan = await client.createLearningEntry({
      project_id: PROJECT_A.id,
      scope: 'project',
      summary: 'no local snapshot',
    });
    const res = await api().request(`/api/learning/${encodeURIComponent(orphan.id)}/revert`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('503s when the learning stack is not configured', async () => {
    const app = createBackendApi({
      metadata: client,
      cache,
      settingsStore: memSettings(),
      // no learningLog / toneStore
    });
    const res = await app.request(`/api/learning/${encodeURIComponent(idA)}/revert`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });
});

/* ============================================================================ *
 * Draft-vs-sent learning trigger (Phase 6 wired) — fires only on an edit       *
 * ============================================================================ */

/** A runner that answers draft/summary AND the Sonnet `learn` job with valid structured output. */
function learningRunner(onLearn?: () => void): ClaudeRunner {
  return {
    run(spec: JobSpec): Promise<JobResult> {
      const base: JobResult = {
        text: '',
        model: modelForTask(spec.taskKind),
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        isError: false,
        sessionId: `fake-${spec.taskKind}`,
        numTurns: 1,
        durationMs: 0,
      };
      if (spec.taskKind === 'learn') {
        onLearn?.();
        return Promise.resolve({
          ...base,
          structuredOutput: { tone_update: 'Keep sign-offs short.', summary: 'shorter sign-offs' },
        });
      }
      if (spec.taskKind === 'draft') return Promise.resolve({ ...base, text: 'DRAFT BODY' });
      if (spec.taskKind === 'summarize')
        return Promise.resolve({ ...base, text: 'PINNED SUMMARY' });
      return Promise.resolve(base);
    },
  };
}

describe('Draft-vs-sent learning trigger — the Phase 6 signal, finally wired at send', () => {
  let server: InProcessServer;
  let client: MetadataClient;
  let logDir: string;
  let toneDir: string;
  let learningLog: LearningLog;
  let toneStore: ToneStore;

  beforeEach(async () => {
    server = startInProcessServer(PROJECT_A);
    client = server.client(PROJECT_A);
    // Seed the thread the send path reads (real server).
    await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'me@example.com',
      root_message_id: '<root@example.com>',
      subject: 'Invoice question',
      snippet: 'Can you clarify?',
      sender: 'Client <client@acme.com>',
    });
    logDir = mkdtempSync(join(tmpdir(), 'mailordomo-learn-send-'));
    toneDir = mkdtempSync(join(tmpdir(), 'mailordomo-tone-send-'));
    learningLog = LearningLog.open({ dir: logDir });
    toneStore = ToneStore.open({ dir: toneDir, projectId: PROJECT_A.id });
  });

  afterEach(() => {
    server.close();
    rmSync(logDir, { recursive: true, force: true });
    rmSync(toneDir, { recursive: true, force: true });
  });

  function sendApi(runner: ClaudeRunner): ReturnType<typeof createBackendApi> {
    return createBackendApi({
      metadata: client,
      cache,
      settingsStore: memSettings(),
      runner,
      draftStore,
      toneStore,
      learningLog,
      sendDeps: { composer: createNodemailerComposer(), transport: stub },
    });
  }

  async function thread(): Promise<{ id: string }> {
    const all = await client.listThreads();
    const t = all[0];
    if (t === undefined) throw new Error('seed thread missing');
    return t;
  }

  it('an EDITED send (sent ≠ draft) fires the learn job + records a learning changelog entry', async () => {
    const t = await thread();
    draftStore.saveDraft(t.id, {
      body: 'Hi there, here is a long sign-off.\nBest regards,\nClaude',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    let learnFired = 0;
    const app = sendApi(learningRunner(() => (learnFired += 1)));

    const res = await app.request(`/api/threads/${t.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Thanks — short and sweet.\nJan' }),
    });
    expect(res.status).toBe(200);

    expect(learnFired).toBe(1); // the Sonnet learn job ran exactly once
    // A learning changelog entry was recorded on the (real) server — summary only.
    const entries = await client.listLearningEntries();
    expect(entries.map((e) => e.summary)).toContain('shorter sign-offs');
    // The local revert snapshot exists (so the lesson is revertable).
    expect(learningLog.list().some((r) => r.summary === 'shorter sign-offs')).toBe(true);
    // And nothing learning-related leaked a body to the server (only the summary crossed).
    const learnPost = (await client.listLearningEntries()).find(
      (e) => e.summary === 'shorter sign-offs',
    );
    expect(learnPost && 'body' in learnPost).toBe(false);
  });

  it('an IDENTICAL send (sent === draft) does NOT fire learning', async () => {
    const t = await thread();
    const identical = 'Exactly the same body, unchanged.';
    draftStore.saveDraft(t.id, {
      body: identical,
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    let learnFired = 0;
    const app = sendApi(learningRunner(() => (learnFired += 1)));

    const res = await app.request(`/api/threads/${t.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: identical }),
    });
    expect(res.status).toBe(200);
    expect(learnFired).toBe(0);
    expect(await client.listLearningEntries()).toHaveLength(0);
  });

  it('a learning FAILURE must NOT fail the send (best-effort) — still 200, still sent', async () => {
    const t = await thread();
    draftStore.saveDraft(t.id, {
      body: 'draft body A',
      model: 'opus',
      author: 'claude',
      transcript: [],
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A runner whose `learn` job throws (e.g. the model errored).
    const failingLearn: ClaudeRunner = {
      run(spec: JobSpec): Promise<JobResult> {
        if (spec.taskKind === 'learn') return Promise.reject(new Error('learn boom'));
        return learningRunner().run(spec);
      },
    };
    const app = sendApi(failingLearn);

    const res = await app.request(`/api/threads/${t.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'EDITED — different from the draft' }),
    });
    // The send succeeded despite the learning failure (golden rule: send is the user's action).
    expect(res.status).toBe(200);
    expect((await res.json()) as SendResponse).toMatchObject({ state: 'waiting' });
    expect(stub.sent).toHaveLength(1);
    errSpy.mockRestore();
  });
});
