/**
 * MINIMAL smoke tests for {@link MetadataClient} — proving the seams the Phase 4.5 integration
 * test-author builds on: the injectable `fetch`, the auth headers, response validation, and the
 * error taxonomy. The LOAD-BEARING round-trip (real client ↔ in-process `createApp` server) is the
 * separate test-author's job (see the header of `client.ts` for the exact seam).
 */
import { describe, expect, it } from 'vitest';
import type { Thread } from '@mailordomo/shared';
import { MetadataClient } from './client';
import { MetadataAuthError, MetadataError, MetadataValidationError } from './errors';
import type { FetchLike } from './client';

const SAMPLE_THREAD: Thread = {
  id: 'th_1',
  project_id: 'proj_1',
  mailbox_address: 'jan@example.com',
  root_message_id: '<root@example.com>',
  subject: 'Hello',
  snippet: 'a short preview',
  sender: 'Alice <alice@example.com>',
  last_message_at: '2026-06-01T10:00:00.000Z',
  updated_at: '2026-06-01T10:00:00.000Z',
};

/** Capture the request a single call makes, and reply with a canned JSON body + status. */
function stubFetch(
  reply: { status: number; body: unknown },
  capture?: (req: { url: string; init: RequestInit | undefined }) => void,
): FetchLike {
  return (url, init) => {
    capture?.({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

function client(fetchImpl: FetchLike): MetadataClient {
  return new MetadataClient({
    baseUrl: 'http://metadata.local/',
    projectId: 'proj_1',
    token: 'sekret',
    fetch: fetchImpl,
  });
}

describe('MetadataClient', () => {
  it('sends bearer auth + X-Project-Id and hits the right URL (trailing slash normalized)', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const c = client(stubFetch({ status: 200, body: [SAMPLE_THREAD] }, (req) => (seen = req)));
    await c.listThreads();
    expect(seen?.url).toBe('http://metadata.local/threads');
    const headers = seen?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sekret');
    expect(headers['X-Project-Id']).toBe('proj_1');
  });

  it('validates a list response against the shared DTO', async () => {
    const c = client(stubFetch({ status: 200, body: [SAMPLE_THREAD] }));
    const threads = await c.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('th_1');
  });

  it('pair() returns the authed project (identity only)', async () => {
    const c = client(stubFetch({ status: 200, body: { project: { id: 'proj_1', name: 'Acme' } } }));
    const project = await c.pair();
    expect(project).toEqual({ id: 'proj_1', name: 'Acme' });
  });

  it('throws MetadataAuthError on 401', async () => {
    const c = client(
      stubFetch({ status: 401, body: { error: 'bad token', code: 'unauthorized' } }),
    );
    await expect(c.listThreads()).rejects.toBeInstanceOf(MetadataAuthError);
  });

  it('throws MetadataError (with status + code) on a non-401 failure', async () => {
    const c = client(
      stubFetch({ status: 404, body: { error: 'thread not found', code: 'not_found' } }),
    );
    await expect(c.getThread('nope')).rejects.toMatchObject({
      name: 'MetadataError',
      status: 404,
      code: 'not_found',
    });
  });

  it('throws MetadataValidationError when a 2xx body fails the contract', async () => {
    const c = client(stubFetch({ status: 200, body: { not: 'a thread' } }));
    await expect(c.getThread('th_1')).rejects.toBeInstanceOf(MetadataValidationError);
  });

  it('surfaces lock contention (409) as a {acquired:false} body, not a throw', async () => {
    const heldLock = {
      thread_id: 'th_1',
      locked_by: 'simona',
      locked_at: '2026-06-01T10:00:00.000Z',
      expires_at: '2026-06-01T10:30:00.000Z',
    };
    const c = client(stubFetch({ status: 409, body: { acquired: false, lock: heldLock } }));
    const result = await c.acquireLock({ thread_id: 'th_1', locked_by: 'jan' });
    expect(result.acquired).toBe(false);
    expect(result.lock.locked_by).toBe('simona');
  });

  it('wraps a transport failure as MetadataError(status 0)', async () => {
    const c = client(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(c.listThreads()).rejects.toBeInstanceOf(MetadataError);
    await expect(c.listThreads()).rejects.toMatchObject({ status: 0 });
  });
});
