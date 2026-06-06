/**
 * Windowed transitions read INTENT coverage (separate test-author, fresh context — PLAN.md §4.4).
 * The morning digest's "what Simona handled" feed is built PURELY from actor-attributed transitions on
 * SERVER metadata (Golden rule #3 — never her message body). This drives `MetadataClient.
 * listTransitionsInWindow` against the REAL in-process metadata server (the new `GET /transitions`
 * route) and derives, from intent, what it MUST return:
 *
 *   - ONLY transitions whose `at` falls inside `[window_start, window_end]` (out-of-window excluded);
 *   - each carries its thread SUBJECT + the actor attribution, and is BODY-FREE (strict shared schema);
 *   - it is PROJECT-SCOPED — another project's transitions never leak in;
 *   - newest-first ordering.
 *
 * ADDITIVE to `server/transitions.test.ts` (which covers POST + concurrency, not the windowed GET) and
 * to `integration/digest.smoke.test.ts` (which checks the end-to-end digest, not the read in isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestTransitionListResponseSchema } from '@mailordomo/shared';
import { PROJECT_A, PROJECT_B, startInProcessServer, type InProcessServer } from './harness';

const WINDOW = { start: '2026-06-05T00:00:00.000Z', end: '2026-06-06T00:00:00.000Z' };

describe('listTransitionsInWindow — actor-attributed, in-window, body-free (intent)', () => {
  let server: InProcessServer;

  beforeEach(() => {
    // Both projects exist so PROJECT_A and PROJECT_B tokens are both accepted.
    server = startInProcessServer(PROJECT_A, PROJECT_B);
  });

  afterEach(() => {
    server.close();
  });

  /**
   * Create a thread + task in `project`, then record a transition to `to` attributed to `actor`. The
   * server stamps `at` itself (we cannot backdate via the API), so to test the window we record one
   * transition NOW and assert behavior with windows that DO and DON'T contain "now".
   */
  async function recordTransition(
    project: typeof PROJECT_A,
    subject: string,
    actor: 'simona' | 'jan' | 'claude',
    to: 'done' | 'waiting' | 'drafted',
  ): Promise<string> {
    const client = server.client(project);
    const thread = await client.upsertThread({
      project_id: project.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: `<${subject.replace(/\s+/g, '-')}@host>`,
      subject,
      snippet: 'a snippet',
      sender: 'Client <client@acme.com>',
    });
    const taskRec = await client.createTask({ thread_id: thread.id, state: 'needs-reply' });
    const tr = await client.createTransition(taskRec.id, { to, actor });
    return tr.at; // the server-stamped instant
  }

  it('returns an in-NOW window transition with subject + actor, body-free', async () => {
    const at = await recordTransition(PROJECT_A, 'Cleared by Simona', 'simona', 'done');
    // A window that brackets "now" (the server stamped `at` ≈ now).
    const start = new Date(Date.parse(at) - 60_000).toISOString();
    const end = new Date(Date.parse(at) + 60_000).toISOString();

    const rows = await server.client(PROJECT_A).listTransitionsInWindow({ start, end });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: 'Cleared by Simona',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona',
    });
    expect(rows[0]?.at).toBe(at);
    // Strict shared schema ⇒ body-free by construction; and no body-ish key in the raw rows.
    expect(() => DigestTransitionListResponseSchema.parse(rows)).not.toThrow();
    expect(JSON.stringify(rows)).not.toMatch(/"body"|"html"|"text_body"|"raw"/);
  });

  it('EXCLUDES a transition stamped OUTSIDE the window (the past-window WINDOW const has no "now")', async () => {
    // The transition is stamped at ≈ now (2026-06+), but WINDOW ends 2026-06-06T00:00 — well before now.
    await recordTransition(PROJECT_A, 'Old move', 'simona', 'done');
    const rows = await server.client(PROJECT_A).listTransitionsInWindow(WINDOW);
    expect(rows).toHaveLength(0);
  });

  it('is PROJECT-SCOPED: another project’s transitions never leak in', async () => {
    const atA = await recordTransition(PROJECT_A, 'A-thread move', 'simona', 'done');
    await recordTransition(PROJECT_B, 'B-thread move', 'jan', 'waiting');
    const start = new Date(Date.parse(atA) - 60_000).toISOString();
    const end = new Date(Date.parse(atA) + 60_000).toISOString();

    const rowsA = await server.client(PROJECT_A).listTransitionsInWindow({ start, end });
    expect(rowsA.map((r) => r.subject)).toEqual(['A-thread move']); // only A's transition
    expect(rowsA.every((r) => r.subject !== 'B-thread move')).toBe(true);
  });

  it('returns multiple in-window transitions newest-first', async () => {
    const at1 = await recordTransition(PROJECT_A, 'First move', 'simona', 'done');
    const at2 = await recordTransition(PROJECT_A, 'Second move', 'jan', 'drafted');
    const lo = Math.min(Date.parse(at1), Date.parse(at2)) - 60_000;
    const hi = Math.max(Date.parse(at1), Date.parse(at2)) + 60_000;
    const rows = await server.client(PROJECT_A).listTransitionsInWindow({
      start: new Date(lo).toISOString(),
      end: new Date(hi).toISOString(),
    });

    expect(rows).toHaveLength(2);
    // Newest first: at >= prior at across the list.
    for (let i = 1; i < rows.length; i++) {
      expect(Date.parse(rows[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(rows[i]!.at));
    }
    expect(rows.map((r) => r.actor).sort()).toEqual(['jan', 'simona']);
  });
});
