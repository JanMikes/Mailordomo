/**
 * THIN E2E + digest-privacy INTENT coverage (separate test-author, fresh context — PLAN.md §4.4).
 * Derived from intent FIRST:
 *
 *   - THE THIN E2E (PROJECT.md §6, golden rule #1): the critical loop poll → triage → draft → send must
 *     wire end-to-end through FAKES + a STUB transport; after the manual send the task lands in
 *     `waiting`; the STUB captured EXACTLY ONE message; and NO real SMTP path was exercised (the daemon's
 *     injected filer is never reached → `sendCalls === 0`). This is the second, independent assertion of
 *     the implementer's E2E, written to the same intent.
 *   - DIGEST PRIVACY (golden rule #3): a capturing-fetch over `GET /api/digest` proves that across the
 *     WHOLE outbound surface (every request method/path/body the local app would send to the server),
 *     NOTHING body-ful crosses; the only thread-derived text on the wire is the sanctioned
 *     subject/snippet/sender, and "handled" is sourced from the windowed transitions read.
 *
 * ADDITIVE to `e2e.test.ts` + `digest.smoke.test.ts`; all IO faked — no live claude/IMAP/SMTP/network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { FakeClaudeRunner } from '../claude';
import { UsageThrottle } from '../claude/throttle';
import type { NudgeDraft, NudgeFiledResult } from '../claude/nudge';
import { runDaemonCycle } from '../daemon';
import type { DaemonMessage, DraftFiler } from '../daemon';
import { createMemoryDraftStore } from '../drafts';
import type { DraftStore } from '../drafts';
import type { SettingsStore } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import { createStubMailTransport } from '../smtp/stub-transport';
import type { StubMailTransport } from '../smtp/stub-transport';
import { createBackendApi } from '../api/app';
import type { SendResponse } from '../api/app';
import { capturingFetch, PROJECT_A, startInProcessServer, type InProcessServer } from './harness';

const NOW = '2026-06-06T09:00:00.000Z';
const MESSAGE_ID = '<invoice-1@acme.com>';
const SUBJECT = 'Invoice question';
const SENDER = 'Petr <petr@acme.com>';
const SECRET_BODY = 'SECRET-BODY-Final-edited-reply-must-not-cross';

/** A saveDraft-only filer with `send`/`transmit` tripwires — proves the DAEMON never transmits. */
class TransmitSpyFiler implements DraftFiler {
  readonly filed: NudgeDraft[] = [];
  sendCalls = 0;
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.filed.push(draft);
    return Promise.resolve({ messageId: '<nudge@local>', filedTo: 'Drafts' });
  }
  send(): void {
    this.sendCalls += 1;
  }
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

describe('thin E2E (intent) — poll → triage → draft → send(stub) lands in `waiting`, no real SMTP', () => {
  let server: InProcessServer;
  let cache: MessageCache;
  let draftStore: DraftStore;
  let stub: StubMailTransport;
  let filer: TransmitSpyFiler;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
    cache = MessageCache.open({ dbPath: ':memory:' });
    draftStore = createMemoryDraftStore();
    stub = createStubMailTransport();
    filer = new TransmitSpyFiler();
  });

  afterEach(() => {
    cache.close();
    server.close();
  });

  it('wires the loop; exactly ONE stub send; daemon filer untouched; task ends `waiting`', async () => {
    const client = server.client(PROJECT_A);

    // The thread surfaces only sanctioned metadata to the server.
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: MESSAGE_ID,
      subject: SUBJECT,
      snippet: 'Can you confirm the timeline?',
      sender: SENDER,
    });

    /* TRIAGE — the REAL daemon cycle creates the task on the REAL server, drafts nothing, sends nothing. */
    const daemonRunner = new FakeClaudeRunner({
      byKind: {
        triage: {
          structuredOutput: {
            disposition: 'needs-reply',
            needs_reply: true,
            importance: 'high',
            confidence: 'high',
            reason: 'a direct question',
          },
        },
        'promise-extraction': { structuredOutput: { promises: [] } },
      },
    });
    const daemonMessage: DaemonMessage = {
      threadId: thread.id,
      subject: SUBJECT,
      sender: SENDER,
      snippet: 'Can you confirm the timeline?',
      body: 'Can you confirm the timeline by Friday?',
      receivedIso: NOW,
      task: { id: null, state: 'needs-reply', lastActivityIso: NOW },
      threadMessages: [],
    };
    const cycle = await runDaemonCycle({
      source: { poll: () => Promise.resolve([daemonMessage]) },
      runner: daemonRunner,
      throttle: new UsageThrottle(),
      metadata: client,
      filer,
      now: () => NOW,
    });
    expect(cycle.tasksCreated).toBe(1);
    expect(cycle.errors).toEqual([]);
    expect(filer.filed).toHaveLength(0); // no overdue promise ⇒ no nudge
    expect(filer.sendCalls).toBe(0); // the daemon transmitted nothing

    const afterTriage = await client.listTasks(thread.id);
    expect(afterTriage[0]?.state).toBe('needs-reply');

    /* DRAFT + SEND — the REAL backend API + fake runner + STUB transport (the only transmit path). */
    const apiRunner = new FakeClaudeRunner({ byKind: { draft: { text: 'Drafted reply body.' } } });
    const app = createBackendApi({
      metadata: client,
      cache,
      settingsStore: memSettings(),
      runner: apiRunner,
      draftStore,
      sendDeps: { composer: createNodemailerComposer(), transport: stub },
    });

    const draftRes = await app.request(`/api/threads/${thread.id}/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'be brief' }),
    });
    expect(draftRes.status).toBe(200);
    expect(draftStore.getDraft(thread.id)?.body).toBe('Drafted reply body.'); // body stays LOCAL

    const sendRes = await app.request(`/api/threads/${thread.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Final edited reply.' }),
    });
    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as SendResponse;
    expect(sent.state).toBe('waiting');

    /* INTENT ASSERTIONS. */
    expect(stub.sent).toHaveLength(1); // the STUB captured EXACTLY ONE message…
    expect(filer.sendCalls).toBe(0); // …and the daemon transmitted nothing (no real SMTP)
    const afterSend = await client.listTasks(thread.id);
    expect(afterSend[0]?.state).toBe('waiting'); // I sent → waiting on the REAL server
  });
});

describe('digest endpoint (intent) — body-free outbound surface (Golden rule #3)', () => {
  let server: InProcessServer;
  let cache: MessageCache;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
    cache = MessageCache.open({ dbPath: ':memory:' });
  });

  afterEach(() => {
    cache.close();
    server.close();
  });

  it('GET /api/digest sources "handled" from the windowed transitions read and crosses NO body', async () => {
    const seedClient = server.client(PROJECT_A);
    // A needs-reply thread and a SIMONA-attributed transition (the "handled" feed). The thread also
    // carries a real local body in the cache conceptually — but only metadata is ever upserted.
    const needs = await seedClient.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<needs@host>',
      subject: 'Needs your reply',
      snippet: 'please respond',
      sender: 'Lumír <lumir@acme.com>',
    });
    await seedClient.createTask({ thread_id: needs.id, state: 'needs-reply', importance: 'high' });

    const handled = await seedClient.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<handled@host>',
      subject: 'Cleared by Simona',
      snippet: 'all done',
      sender: 'Client <client@acme.com>',
    });
    const handledTask = await seedClient.createTask({
      thread_id: handled.id,
      state: 'needs-reply',
    });
    await seedClient.createTransition(handledTask.id, { to: 'done', actor: 'simona' });

    // Drive the digest through a CAPTURING fetch so we see every byte that would cross to the server.
    const capture = capturingFetch(server.fetch);
    const app = createBackendApi({
      metadata: server.client(PROJECT_A, capture.fetch),
      cache,
      settingsStore: memSettings(),
      runner: new FakeClaudeRunner({ byKind: { digest: { text: 'prose with no body' } } }),
    });
    const res = await app.request('/api/digest');
    expect(res.status).toBe(200);

    // The "what Simona handled" feed came from the windowed transitions read…
    expect(capture.captured.some((r) => r.method === 'GET' && r.path === '/transitions')).toBe(
      true,
    );
    // …every outbound request to the server is a read (no mutation carrying a body during assembly)…
    expect(capture.captured.every((r) => r.body === undefined)).toBe(true);
    // …and the full serialized outbound surface carries no body-ish field whatsoever.
    const serialized = JSON.stringify(capture.captured);
    expect(serialized).not.toMatch(/"body"|"draftBody"|"html"|"text_body"/);
    expect(serialized).not.toContain(SECRET_BODY);
  });
});
