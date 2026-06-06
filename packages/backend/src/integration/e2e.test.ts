/**
 * Phase 9 · THE THIN E2E (PLAN.md §5 / D34) — the critical loop end-to-end via the integration
 * harness + FAKES + a STUB transport: **poll → triage → draft → send(stub)**.
 *
 *   poll   — a fake IMAP surface syncs one message into the REAL cache (`MailboxSync`).
 *   triage — the REAL daemon cycle (`runDaemonCycle`) triages it through a fake runner → the state
 *            machine → a metadata write on the REAL in-process metadata server (the task is created).
 *   draft  — the REAL backend API drafts a reply (fake runner) → the LOCAL DraftStore + a body-free
 *            DraftMeta on the server.
 *   send   — the REAL manual-send endpoint transmits through the STUB transport, transitioning the
 *            task to `waiting`.
 *
 * ASSERTS (Golden rule #1): the loop wires end-to-end; the task reaches `waiting` after send; the STUB
 * transport is the ONLY "send" (exactly one) and the DAEMON transmits NOTHING (its injected filer is
 * never reached). No real SMTP ever runs — there is no real transport in the graph.
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
import { MailboxSync } from '../imap/mailbox-sync';
import type {
  ImapClient,
  ImapFetchedMessage,
  ImapFetchQuery,
  ImapFolderInfo,
  ImapMailboxState,
  Unsubscribe,
} from '../imap/types';
import { createMemoryDraftStore } from '../drafts';
import type { DraftStore } from '../drafts';
import type { SettingsStore } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import { createStubMailTransport } from '../smtp/stub-transport';
import type { StubMailTransport } from '../smtp/stub-transport';
import { createBackendApi } from '../api/app';
import type { SendResponse } from '../api/app';
import { PROJECT_A, startInProcessServer, type InProcessServer } from './harness';

const NOW = '2026-06-06T09:00:00.000Z';
const MESSAGE_ID = '<invoice-1@acme.com>';
const SUBJECT = 'Invoice question';
const SENDER = 'Petr <petr@acme.com>';

const MAILBOX_STATE: ImapMailboxState = {
  path: 'INBOX',
  uidValidity: 1n,
  uidNext: 2,
  highestModseq: undefined,
  exists: 1,
  readOnly: true,
};

const FIXTURE_MESSAGE: ImapFetchedMessage = {
  uid: 1,
  flags: new Set<string>(['\\Seen']),
  internalDate: new Date('2026-06-06T08:30:00.000Z'),
  envelope: {
    messageId: MESSAGE_ID,
    subject: SUBJECT,
    from: [{ name: 'Petr', address: 'petr@acme.com' }],
  },
  references: [],
};

/** A minimal fake IMAP surface that yields the single fixture message (mirrors `imap/sync.test.ts`). */
class FakeImapClient implements ImapClient {
  connect(): Promise<void> {
    return Promise.resolve();
  }
  logout(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    /* nothing to close */
  }
  list(): Promise<readonly ImapFolderInfo[]> {
    return Promise.resolve([]);
  }
  openMailbox(): Promise<ImapMailboxState> {
    return Promise.resolve(MAILBOX_STATE);
  }
  async *fetchByUid(_range: string, _query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    yield FIXTURE_MESSAGE;
  }
  onClose(): Unsubscribe {
    return () => undefined;
  }
  onError(): Unsubscribe {
    return () => undefined;
  }
  onExists(): Unsubscribe {
    return () => undefined;
  }
}

/** A saveDraft-only filer with a `send` tripwire — proves the DAEMON never transmits. */
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

describe('Phase 9 thin E2E — poll → triage → draft → send(stub), no real SMTP', () => {
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

  it('wires the critical loop and reaches `waiting` after a single stubbed send', async () => {
    const client = server.client(PROJECT_A);

    /* 1) POLL — fake IMAP fixtures sync into the REAL cache. */
    const sync = new MailboxSync(new FakeImapClient(), cache, {
      mailboxAddress: 'jan@acme.com',
      folderPath: 'INBOX',
      readOnly: true,
      downloadSource: false,
    });
    const syncResult = await sync.syncOnce();
    expect(syncResult.fetched).toBe(1);
    expect(cache.getMessagesByMessageId(MESSAGE_ID)).toHaveLength(1); // poll → cache wired

    // The thread surfaces its sanctioned metadata to the service (subject/snippet/sender only).
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: MESSAGE_ID,
      subject: SUBJECT,
      snippet: 'Can you confirm the timeline?',
      sender: SENDER,
    });

    /* 2) TRIAGE — the REAL daemon cycle: fake runner → state machine → metadata write. */
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

    // The daemon's triage created the task on the REAL server, in the triaged state.
    const afterTriage = await client.listTasks(thread.id);
    expect(afterTriage).toHaveLength(1);
    expect(afterTriage[0]?.state).toBe('needs-reply');
    // The daemon transmitted NOTHING (no overdue promise ⇒ no nudge; filer untouched).
    expect(filer.filed).toHaveLength(0);
    expect(filer.sendCalls).toBe(0);

    /* 3) DRAFT + 4) SEND — the REAL backend API with a fake runner + the STUB transport. */
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
    const draftMeta = await client.listDraftMeta(thread.id);
    expect(draftMeta).toHaveLength(1); // body-free meta crossed to the server

    const sendRes = await app.request(`/api/threads/${thread.id}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Final edited reply.' }),
    });
    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as SendResponse;
    expect(sent.state).toBe('waiting');

    /* ASSERTIONS — golden rule #1: exactly one stubbed send, zero real SMTP, task now waiting. */
    expect(stub.sent).toHaveLength(1); // the STUB is the ONLY transmission
    expect(filer.sendCalls).toBe(0); // the daemon never transmitted
    const afterSend = await client.listTasks(thread.id);
    expect(afterSend[0]?.state).toBe('waiting'); // I sent → waiting (on the REAL server)
    expect(draftStore.getDraft(thread.id)).toBeUndefined(); // local draft cleared after send
  });
});
