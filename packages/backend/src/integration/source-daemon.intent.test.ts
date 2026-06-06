/**
 * WHOLE-LOOP intent test (PLAN.md D34/D35; PROJECT.md §6 daemon loop + Golden rule #1) — drive the
 * REAL daemon orchestrator `runDaemonCycle` over the REAL live source `createCacheDaemonSource`,
 * so mail flows end-to-end: **IMAP poll → cache → enumerate → triage → state → metadata**.
 *
 * This is the strong wiring proof the source-only tests cannot give: it stitches the new source seam
 * (D35) to the daemon cycle (D34) over the REAL in-process metadata server + a REAL in-memory cache.
 *
 * ASSERTS:
 *  - the task is CREATED on the REAL metadata server in the triaged state (poll→triage→state wired);
 *  - GOLDEN RULE #1 over the live source: a hostile transmit-spy {@link DraftFiler} is NEVER asked to
 *    transmit (`sendCalls === 0`) and never even files a draft here (no overdue inbound promise) — the
 *    daemon cannot send;
 *  - GOLDEN RULE #3 across the whole loop: a unique body marker placed AFTER the snippet bound never
 *    crosses to the server in ANY outbound request (`capturingFetch`);
 *  - idempotency through the daemon: a second cycle over an unchanged mailbox processes 0 messages and
 *    creates no duplicate task (the source enumerates only new arrivals).
 *
 * FAKES + REAL server + REAL cache only. NO live IMAP, NO live `claude`, NO network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageCache } from '../cache';
import { FakeClaudeRunner } from '../claude';
import { UsageThrottle } from '../claude/throttle';
import type { NudgeDraft, NudgeFiledResult } from '../claude/nudge';
import { runDaemonCycle } from '../daemon';
import type { DraftFiler } from '../daemon';
import { createCacheDaemonSource } from '../source/cache-source';
import type {
  ImapClient,
  ImapFetchedMessage,
  ImapFetchQuery,
  ImapFolderInfo,
  ImapMailboxState,
  Unsubscribe,
} from '../imap/types';
import { capturingFetch, PROJECT_A, startInProcessServer } from './harness';
import type { InProcessServer } from './harness';

const MAILBOX = 'jan@acme.com';

function rawEml(messageId: string, subject: string, body: string): Buffer {
  return Buffer.from(
    [
      'From: Petr <petr@acme.com>',
      `To: ${MAILBOX}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      'Date: Fri, 06 Jun 2026 08:30:00 +0000',
      '',
      body,
      '',
    ].join('\r\n'),
  );
}

function fixture(
  uid: number,
  messageId: string,
  subject: string,
  body: string,
): ImapFetchedMessage {
  return {
    uid,
    flags: new Set<string>(['\\Seen']),
    internalDate: new Date(`2026-06-06T08:${String(10 + uid).padStart(2, '0')}:00.000Z`),
    envelope: { messageId, subject, from: [{ name: 'Petr', address: 'petr@acme.com' }] },
    references: [],
    source: rawEml(messageId, subject, body),
  };
}

/** A growable fake IMAP surface (full-resync on `1:*`, incremental on `N:*`). */
class FakeImap implements ImapClient {
  private readonly messages: ImapFetchedMessage[];
  constructor(initial: readonly ImapFetchedMessage[]) {
    this.messages = [...initial];
  }
  push(message: ImapFetchedMessage): void {
    this.messages.push(message);
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  logout(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    /* nothing */
  }
  list(): Promise<readonly ImapFolderInfo[]> {
    return Promise.resolve([]);
  }
  openMailbox(): Promise<ImapMailboxState> {
    const maxUid = this.messages.reduce((m, x) => Math.max(m, x.uid), 0);
    return Promise.resolve({
      path: 'INBOX',
      uidValidity: 1n,
      uidNext: maxUid + 1,
      highestModseq: undefined,
      exists: this.messages.length,
      readOnly: true,
    });
  }
  async *fetchByUid(range: string, _query: ImapFetchQuery): AsyncIterable<ImapFetchedMessage> {
    const lower = range.startsWith('1:') ? 1 : Number.parseInt(range.split(':')[0] ?? '1', 10);
    for (const message of this.messages) if (message.uid >= lower) yield message;
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

/** saveDraft-only filer with a `send` tripwire — proves the DAEMON never transmits over the live source. */
class TransmitSpyFiler implements DraftFiler {
  readonly filed: NudgeDraft[] = [];
  sendCalls = 0;
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
    this.filed.push(draft);
    return Promise.resolve({ messageId: '<nudge@local>', filedTo: 'Drafts' });
  }
  /** NOT part of DraftFiler — a tripwire. The cycle has no path to call this. */
  send(): void {
    this.sendCalls += 1;
  }
}

/** A runner that answers triage `needs-reply` and extracts no promises (so no nudge is even eligible). */
function daemonRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner({
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
      summarize: { text: 'A short thread summary.' },
    },
  });
}

describe('whole-loop: live source → runDaemonCycle (D34/D35)', () => {
  let server: InProcessServer;
  let cache: MessageCache;
  let blobDir: string;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
    blobDir = mkdtempSync(join(tmpdir(), 'mailordomo-loop-'));
    cache = MessageCache.open({ dbPath: ':memory:', blobDir });
  });

  afterEach(() => {
    cache.close();
    server.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  it('polls real mail → triages → creates the task on the REAL server, and the daemon sends NOTHING', async () => {
    const client = server.client(PROJECT_A);
    const fake = new FakeImap([
      fixture(
        1,
        '<loop-1@acme.com>',
        'Invoice question',
        'Can you confirm the timeline by Friday?',
      ),
    ]);
    const source = createCacheDaemonSource({
      connection: { client: fake },
      cache,
      metadata: client,
      mailbox: { address: MAILBOX },
      folders: [{ path: 'INBOX' }],
      projectId: PROJECT_A.id,
      now: () => '2026-06-06T09:00:00.000Z',
      logger: () => undefined,
    });
    const filer = new TransmitSpyFiler();

    const result = await runDaemonCycle({
      source,
      runner: daemonRunner(),
      throttle: new UsageThrottle(),
      metadata: client,
      filer,
      now: () => '2026-06-06T09:00:00.000Z',
    });

    // The loop wired: the source upserted the thread, the cycle triaged + created the task.
    expect(result.processed).toBe(1);
    expect(result.tasksCreated).toBe(1);
    expect(result.errors).toEqual([]);

    const threads = await client.listThreads();
    expect(threads).toHaveLength(1);
    const tasks = await client.listTasks(threads[0]?.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe('needs-reply'); // created on the REAL server in the triaged state

    // GOLDEN RULE #1 over the live source: the daemon never transmitted (and filed no draft here).
    expect(filer.sendCalls).toBe(0);
    expect(filer.filed).toHaveLength(0);
  });

  it('GOLDEN RULE #3 — across the whole loop, the full body never crosses to the server', async () => {
    const capture = capturingFetch(server.fetch);
    const client = server.client(PROJECT_A, capture.fetch);
    const marker = 'WHOLE-LOOP-SECRET-PAST-BOUND-7c1d';
    const body = `${'filler text here '.repeat(20)}${marker}`; // > 200 chars, marker after the bound
    const fake = new FakeImap([fixture(1, '<loop-priv@acme.com>', 'Privacy', body)]);
    const source = createCacheDaemonSource({
      connection: { client: fake },
      cache,
      metadata: client,
      mailbox: { address: MAILBOX },
      folders: [{ path: 'INBOX' }],
      projectId: PROJECT_A.id,
      now: () => '2026-06-06T09:00:00.000Z',
      logger: () => undefined,
    });

    await runDaemonCycle({
      source,
      runner: daemonRunner(),
      throttle: new UsageThrottle(),
      metadata: client,
      filer: new TransmitSpyFiler(),
      now: () => '2026-06-06T09:00:00.000Z',
    });

    expect(capture.captured.length).toBeGreaterThan(0);
    for (const request of capture.captured) {
      expect(request.rawBody ?? '').not.toContain(marker);
    }
  });

  it('idempotent through the daemon: a second cycle over an unchanged mailbox creates no duplicate task', async () => {
    const client = server.client(PROJECT_A);
    const fake = new FakeImap([fixture(1, '<loop-idem@acme.com>', 'Topic', 'A single message.')]);
    const source = createCacheDaemonSource({
      connection: { client: fake },
      cache,
      metadata: client,
      mailbox: { address: MAILBOX },
      folders: [{ path: 'INBOX' }],
      projectId: PROJECT_A.id,
      now: () => '2026-06-06T09:00:00.000Z',
      logger: () => undefined,
    });
    const deps = {
      source,
      runner: daemonRunner(),
      throttle: new UsageThrottle(),
      metadata: client,
      filer: new TransmitSpyFiler(),
      now: () => '2026-06-06T09:00:00.000Z',
    };

    const first = await runDaemonCycle(deps);
    expect(first.tasksCreated).toBe(1);

    const second = await runDaemonCycle(deps);
    expect(second.processed).toBe(0); // nothing new ⇒ the daemon does no work
    expect(second.tasksCreated).toBe(0);

    // Exactly one task on the thread — no duplicate from re-triaging the same message.
    const threads = await client.listThreads();
    expect(await client.listTasks(threads[0]?.id)).toHaveLength(1);
  });
});
