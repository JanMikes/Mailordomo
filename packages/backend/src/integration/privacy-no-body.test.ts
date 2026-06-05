/**
 * Phase 4.5 · Test 4 — PRIVACY: NO BODY CROSSES TO THE SERVER (DoD c; Golden rule #3).
 *
 * Intent (PLAN.md §7 Phase 4.5 "no body data crosses to the server (privacy assertion)";
 * PROJECT.md §5 / Golden rule #3 "Email bodies never leave the local machine"): wrap the REAL
 * client's injected `fetch` to CAPTURE every outbound request body, exercise ALL of the client's
 * write methods against the in-process REAL server, and assert that NONE of the captured bodies
 * carry an email/draft body field (`draftBody`, `emlContent`, `rawMessage`, `bodyText`, … — and a
 * bare `body`/`content` ANYWHERE other than the two sanctioned exceptions, which this client doesn't
 * even expose). This asserts the privacy boundary at the client's OUTBOUND SURFACE — the exact bytes
 * that would hit the network — complementing the server's strict-DTO rejection (`shared/privacy.ts`)
 * and the construction-time guarantee that the client only accepts strict shared DTOs as arguments.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_SERVER_PAYLOAD_KEYS } from '@mailordomo/shared';
import type { Thread } from '@mailordomo/shared';
import type { MetadataClient } from '../metadata-client';
import {
  PROJECT_A,
  capturingFetch,
  startInProcessServer,
  type CapturedRequest,
  type InProcessServer,
} from './harness';

/** Collect every string key appearing ANYWHERE in a JSON value (objects + nested arrays/objects). */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

describe('Phase 4.5 privacy — the real client never sends a body field outbound', () => {
  let server: InProcessServer;
  let capture: ReturnType<typeof capturingFetch>;
  let client: MetadataClient;
  let thread: Thread;

  beforeEach(async () => {
    server = startInProcessServer(PROJECT_A);
    // Wrap the in-process seam so we observe exactly what the client serializes outbound.
    capture = capturingFetch(server.fetch);
    client = server.client(PROJECT_A, capture.fetch);
    thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<privacy-thread@host>',
      subject: 'Re: contract — please confirm the numbers',
      snippet: 'Snippet is sanctioned; the full body is NOT.',
      sender: 'Petr <petr@acme.com>',
      last_message_at: '2026-06-05T08:00:00.000Z',
    });
  });

  afterEach(() => {
    server.close();
  });

  /** Drive every WRITE method the client exposes, so every outbound body is captured. */
  async function exerciseAllWrites(): Promise<void> {
    await client.pair();
    await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<privacy-thread-2@host>',
      subject: 'Another subject',
      snippet: 'another snippet',
      sender: 'Lumír <lumir@acme.com>',
    });
    await client.createTask({
      thread_id: thread.id,
      state: 'needs-reply',
      importance: 'high',
      deadline: '2026-07-01T09:00:00.000Z',
    });
    await client.acquireLock({ thread_id: thread.id, locked_by: 'jan', ttl_seconds: 120 });
    await client.refreshLock({ thread_id: thread.id, locked_by: 'jan', ttl_seconds: 600 });
    await client.releaseLock({ thread_id: thread.id, locked_by: 'jan' });
  }

  function bodyRequests(): CapturedRequest[] {
    return capture.captured.filter((r) => r.rawBody !== undefined);
  }

  it('captures outbound bodies for every write method (sanity: the capture is wired)', async () => {
    await exerciseAllWrites();
    const written = bodyRequests();
    // pair + upsertThread(beforeEach) + upsertThread + createTask + acquire + refresh + release.
    expect(written.length).toBeGreaterThanOrEqual(6);
    const paths = new Set(written.map((r) => r.path));
    expect(paths).toContain('/pair');
    expect(paths).toContain('/threads');
    expect(paths).toContain('/tasks');
    expect(paths).toContain('/locks/acquire');
    expect(paths).toContain('/locks/refresh');
    expect(paths).toContain('/locks/release');
  });

  it('no captured outbound body contains ANY forbidden body/draft/eml/attachment key', async () => {
    await exerciseAllWrites();
    for (const req of bodyRequests()) {
      const keys = collectKeys(req.body);
      for (const forbidden of FORBIDDEN_SERVER_PAYLOAD_KEYS) {
        expect(
          keys.has(forbidden),
          `forbidden key "${forbidden}" found in outbound ${req.method} ${req.path}: ${req.rawBody}`,
        ).toBe(false);
      }
    }
  });

  it('no captured outbound body contains a bare `body` or `content` key (client exposes neither)', async () => {
    // The two sanctioned `body`/`content` fields live on Note/ToneFile — methods this client does
    // NOT expose. So across the client's ENTIRE outbound surface, neither key may appear at all.
    await exerciseAllWrites();
    for (const req of bodyRequests()) {
      const keys = collectKeys(req.body);
      expect(keys.has('body'), `unexpected bare "body" in ${req.path}: ${req.rawBody}`).toBe(false);
      expect(keys.has('content'), `unexpected bare "content" in ${req.path}: ${req.rawBody}`).toBe(
        false,
      );
    }
  });

  it('the raw outbound payload strings never contain known email/draft body substrings', async () => {
    // Belt-and-braces over the SERIALIZED bytes (not just parsed keys): even a smuggled value can't
    // ride along, because the strict DTOs reject undeclared keys before serialization. We assert the
    // wire bytes are clean of the forbidden KEY tokens as they'd appear JSON-serialized.
    await exerciseAllWrites();
    for (const req of bodyRequests()) {
      const raw = req.rawBody ?? '';
      for (const forbidden of FORBIDDEN_SERVER_PAYLOAD_KEYS) {
        expect(raw.includes(`"${forbidden}"`), `"${forbidden}" in wire bytes of ${req.path}`).toBe(
          false,
        );
      }
    }
  });

  it('the privacy guard is REAL: a forbidden key WOULD be detected if it were present', async () => {
    // Mutation-style self-check on the assertion itself — prove collectKeys + the forbidden list trip
    // on a planted body, so a green suite means "clean", not "the check is vacuous".
    const planted = { thread_id: thread.id, draftBody: 'Dear Petr, the numbers are ...' };
    const keys = collectKeys(planted);
    expect(FORBIDDEN_SERVER_PAYLOAD_KEYS.some((k) => keys.has(k))).toBe(true);
  });
});
