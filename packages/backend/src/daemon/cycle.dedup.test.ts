/**
 * Daemon promise-IDEMPOTENCY regression (review fix M1) — re-processing the SAME message across two
 * cycles must NOT create duplicate promise rows. This matters because the daemon CAN legitimately see
 * a message twice: the cache is disposable (a rebuild-from-empty re-emits the recent backlog), and an
 * IDLE-hot trigger can overlap a cold poll. The cycle dedups `createPromise` against the promises
 * already on the thread, so the 3-way tracker stays correct (PROJECT.md §7).
 *
 * Driven against the REAL in-process metadata server (the dedup reads back `listPromises`), with a
 * fake runner (no `claude`) — so this is deterministic and asserts the real create/read path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClaudeRunner } from '../claude/fake-runner';
import { UsageThrottle } from '../claude/throttle';
import type { NudgeDraft, NudgeFiledResult } from '../claude/nudge';
import { runDaemonCycle } from './cycle';
import type { DaemonMessage, DraftFiler } from './types';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';

const NOW = '2026-06-06T09:00:00.000Z';
const MESSAGE_ID = '<spec-1@acme.com>';

/** A runner that triages needs-reply and extracts exactly ONE my-promise candidate every call. */
function makeRunner(): FakeClaudeRunner {
  return new FakeClaudeRunner({
    byKind: {
      triage: {
        structuredOutput: {
          disposition: 'needs-reply',
          needs_reply: true,
          importance: 'normal',
          confidence: 'high',
          reason: 'a request',
        },
      },
      'promise-extraction': {
        structuredOutput: {
          promises: [
            {
              direction_hint: 'my-promise',
              text: 'Send Petr the v2 API spec',
              due_raw: null,
              due_at: null,
              who: 'me',
              whom: 'Petr',
              fulfillment_signal: 'none',
              confidence: 'high',
            },
          ],
        },
      },
      summarize: { text: 'A short summary.' },
    },
  });
}

/** A saveDraft-only filer with a transmit tripwire (golden rule #1 — the daemon never sends). */
class TransmitSpyFiler implements DraftFiler {
  sendCalls = 0;
  saveDraft(_draft: NudgeDraft): Promise<NudgeFiledResult> {
    return Promise.resolve({ messageId: '<nudge@local>', filedTo: 'Drafts' });
  }
  send(): void {
    this.sendCalls += 1;
  }
}

describe('daemon promise idempotency (M1) — re-processing a message does not duplicate promises', () => {
  let server: InProcessServer;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A);
  });
  afterEach(() => {
    server.close();
  });

  it('creates the promise once across two cycles over the same message', async () => {
    const client = server.client(PROJECT_A);
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: MESSAGE_ID,
      subject: 'Spec',
      snippet: 'Please send the spec.',
      sender: 'Petr <petr@acme.com>',
    });

    const message: DaemonMessage = {
      threadId: thread.id,
      subject: 'Spec',
      sender: 'Petr <petr@acme.com>',
      snippet: 'Please send the spec.',
      body: 'Please send Petr the v2 API spec.',
      receivedIso: NOW,
      task: { id: null, state: 'needs-reply', lastActivityIso: NOW },
      threadMessages: [],
    };
    const filer = new TransmitSpyFiler();
    const deps = {
      source: { poll: () => Promise.resolve([message]) },
      runner: makeRunner(),
      throttle: new UsageThrottle(),
      metadata: client,
      filer,
      now: () => NOW,
    };

    const first = await runDaemonCycle(deps);
    expect(first.promisesCreated).toBe(1);

    // Same message again (simulating a cache rebuild re-emitting it / an overlapping trigger).
    const second = await runDaemonCycle(deps);
    expect(second.promisesCreated).toBe(0); // deduped — nothing new created

    // The server holds exactly ONE promise for the thread, not two.
    const promises = await client.listPromises(thread.id);
    expect(promises).toHaveLength(1);
    expect(promises[0]?.text).toBe('Send Petr the v2 API spec');
    expect(filer.sendCalls).toBe(0); // golden rule #1 — never sends
  });
});
