/**
 * Phase 9 · DIGEST ENDPOINT + windowed transitions read — SMOKE coverage against the REAL in-process
 * metadata server (PLAN.md D34). Proves the privacy-load-bearing path end-to-end:
 *   - `GET /api/digest` assembles the body-free DigestMetadata from server metadata + runs the local
 *     Sonnet synthesis;
 *   - the "handled" section comes ONLY from actor-attributed transitions (the new `GET /transitions`
 *     windowed read) — the "what Simona handled" feed (Golden rule #3);
 *   - the synthesis is DEFERRABLE — backpressured by the usage throttle (prose omitted, metadata kept);
 *   - NOTHING body-ful crosses to the server during assembly (a capturing fetch deep-scan).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DigestMetadataSchema, DEFAULT_APP_SETTINGS, AppSettingsSchema } from '@mailordomo/shared';
import type { AppSettings, DigestMetadata } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { FakeClaudeRunner } from '../claude';
import { UsageThrottle } from '../claude/throttle';
import type { SettingsStore } from '../settings';
import { createBackendApi } from '../api/app';
import { capturingFetch, PROJECT_A, startInProcessServer, type InProcessServer } from './harness';

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

interface DigestResponse {
  readonly metadata: DigestMetadata;
  readonly prose: string;
}

describe('Phase 9 digest endpoint (smoke) — REAL server, actor-attributed handled, body-free', () => {
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

  /** Seed: a needs-reply thread, a due they-asked promise, and a SIMONA-attributed transition + draft. */
  async function seed(): Promise<void> {
    const client = server.client(PROJECT_A);
    const needsThread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<needs@host>',
      subject: 'Needs your reply',
      snippet: 'please respond',
      sender: 'Lumír <lumir@acme.com>',
    });
    await client.createTask({
      thread_id: needsThread.id,
      state: 'needs-reply',
      importance: 'high',
    });

    const handledThread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<handled@host>',
      subject: 'Cleared by Simona',
      snippet: 'all done',
      sender: 'Client <client@acme.com>',
    });
    const handledTask = await client.createTask({
      thread_id: handledThread.id,
      state: 'needs-reply',
    });
    // Simona moves it to done — the actor-attributed transition the digest reports.
    await client.createTransition(handledTask.id, { to: 'done', actor: 'simona' });
    await client.createDraftMeta({
      thread_id: handledThread.id,
      version: 1,
      model: 'opus',
      author: 'claude',
    });
    await client.createPromise({
      thread_id: needsThread.id,
      direction: 'they-asked',
      text: 'Send the revised quote',
      due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago ⇒ due
      actor: 'me',
    });
  }

  it('assembles body-free metadata (handled = actor-attributed) and synthesizes prose', async () => {
    await seed();
    const runner = new FakeClaudeRunner({
      byKind: { digest: { text: 'Good morning — one thing needs you; Simona cleared one.' } },
    });
    const app = createBackendApi({
      metadata: server.client(PROJECT_A),
      cache,
      settingsStore: memSettings(),
      runner,
    });

    const res = await app.request('/api/digest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as DigestResponse;

    // Strict shared schema ⇒ body-free by construction.
    expect(() => DigestMetadataSchema.parse(body.metadata)).not.toThrow();
    // needs_you surfaced the needs-reply thread; handled is the SIMONA-attributed transition.
    expect(body.metadata.needs_you.map((r) => r.subject)).toContain('Needs your reply');
    expect(body.metadata.handled.map((h) => h.actor)).toEqual(['simona']);
    expect(body.metadata.handled[0]?.subject).toBe('Cleared by Simona');
    expect(body.metadata.promises_due.map((p) => p.text)).toContain('Send the revised quote');
    expect(body.metadata.drafted).toHaveLength(1);
    // The local Sonnet synthesis produced prose.
    expect(body.prose).toBe('Good morning — one thing needs you; Simona cleared one.');
  });

  it('DEFERS synthesis under throttle backpressure: metadata returns, prose is omitted', async () => {
    await seed();
    const app = createBackendApi({
      metadata: server.client(PROJECT_A),
      cache,
      settingsStore: memSettings(),
      runner: new FakeClaudeRunner({ byKind: { digest: { text: 'should not run' } } }),
      throttle: new UsageThrottle({ throttle: 0 }), // always over ⇒ deferrable digest refused
    });
    const res = await app.request('/api/digest');
    const body = (await res.json()) as DigestResponse;
    expect(body.prose).toBe(''); // backpressured
    expect(body.metadata.handled).toHaveLength(1); // metadata still assembled
  });

  it('PRIVACY: nothing body-ful crosses to the server during digest assembly', async () => {
    await seed();
    const capture = capturingFetch(server.fetch);
    const app = createBackendApi({
      metadata: server.client(PROJECT_A, capture.fetch),
      cache,
      settingsStore: memSettings(),
      runner: new FakeClaudeRunner({ byKind: { digest: { text: 'prose' } } }),
    });
    await app.request('/api/digest');

    // The windowed transitions read happened...
    expect(capture.captured.some((r) => r.method === 'GET' && r.path === '/transitions')).toBe(
      true,
    );
    // ...and every outbound request to the server is body-free (the reads are all GETs).
    const serialized = JSON.stringify(capture.captured);
    expect(serialized).not.toMatch(/"body"|"draftBody"|"html"|"text_body"/);
  });
});
