/**
 * MINIMAL smoke tests for {@link createBackendApi} — proving the factory wires, the two endpoints
 * return the documented shapes, and `/api/wiring` never throws even when a layer is down. Uses an
 * IN-MEMORY {@link MessageCache} and INJECTED health checks (no socket, no `which claude`, no live
 * server). The end-to-end cache-rebuild + cross-instance-lock integration tests are the separate
 * test-author's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import type { WiringReport } from './wiring';
import type { ThreadsResponse } from './app';
import { createBackendApi } from './app';

let cache: MessageCache;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
});

afterEach(() => {
  cache.close();
});

/** A client we never actually call in these tests (the metadata check is injected). */
function dummyClient(): MetadataClient {
  return new MetadataClient({ baseUrl: 'http://unused.local', projectId: 'p', token: 't' });
}

describe('createBackendApi', () => {
  it('GET /api/wiring reports all three layers green when the checks pass', async () => {
    const app = createBackendApi({
      metadata: dummyClient(),
      cache,
      checkMetadata: () => Promise.resolve({ ok: true, detail: 'paired' }),
      checkClaude: () => Promise.resolve({ ok: true, detail: 'on PATH' }),
    });
    const res = await app.request('/api/wiring');
    expect(res.status).toBe(200);
    const report = (await res.json()) as WiringReport;
    expect(report.metadataService.ok).toBe(true);
    expect(report.cache.ok).toBe(true); // a freshly-opened in-memory cache answers
    expect(report.claude.ok).toBe(true);
  });

  it('GET /api/wiring never throws — a down/throwing layer becomes ok:false with a reason', async () => {
    const app = createBackendApi({
      metadata: dummyClient(),
      cache,
      checkMetadata: () => Promise.reject(new Error('connection refused')),
      checkClaude: () => Promise.resolve({ ok: false, detail: 'claude not found on PATH' }),
    });
    const res = await app.request('/api/wiring');
    expect(res.status).toBe(200);
    const report = (await res.json()) as WiringReport;
    expect(report.metadataService).toEqual({
      ok: false,
      detail: 'check threw: connection refused',
    });
    expect(report.claude.ok).toBe(false);
    expect(report.cache.ok).toBe(true);
  });

  it('GET /api/threads returns an empty list for a fresh cache', async () => {
    const app = createBackendApi({ metadata: dummyClient(), cache });
    const res = await app.request('/api/threads');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ThreadsResponse;
    expect(body).toEqual({ threads: [], count: 0 });
  });

  it('GET /api/threads surfaces cached message metadata (subject/snippet/sender), most-recent-first', async () => {
    const folder = cache.upsertFolderMeta({
      mailboxAddress: 'jan@example.com',
      path: 'INBOX',
      uidValidity: '1',
    });
    cache.upsertMessage({
      folderId: folder.id,
      uid: 1,
      uidValidity: '1',
      messageId: '<a@example.com>',
      subject: 'Older',
      sender: 'Alice',
      snippet: 'first',
      internalDate: '2026-06-01T09:00:00.000Z',
    });
    cache.upsertMessage({
      folderId: folder.id,
      uid: 2,
      uidValidity: '1',
      messageId: '<b@example.com>',
      subject: 'Newer',
      sender: 'Bob',
      snippet: 'second',
      internalDate: '2026-06-02T09:00:00.000Z',
    });

    const app = createBackendApi({ metadata: dummyClient(), cache });
    const res = await app.request('/api/threads');
    const body = (await res.json()) as ThreadsResponse;
    expect(body.count).toBe(2);
    expect(body.threads[0]?.subject).toBe('Newer'); // most-recent-first
    expect(body.threads[0]?.sender).toBe('Bob');
    // METADATA ONLY: the payload must never carry a body field (Golden rule #3).
    expect(JSON.stringify(body)).not.toContain('body');
  });
});
