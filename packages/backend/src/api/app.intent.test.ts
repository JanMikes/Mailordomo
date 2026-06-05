/**
 * INTENT (separate test-author) — the D27 SETTINGS → ENGINE WIRING, end-to-end through the REAL
 * backend API (PLAN.md D27/D29). ADDITIVE to `app.smoke.test.ts`.
 *
 * Unlike the smoke (stub clients), this drives `createBackendApi` against the REAL in-process metadata
 * server (the `MetadataClient`'s `fetch` is the server's `app.fetch`) AND a REAL file-backed settings
 * store. It proves the load-bearing claim of D27: a user-changed stale threshold actually REACHES
 * `detectStale` — a 4-day-old `waiting` thread is stale at the default 3 days, then NOT stale after
 * `PUT /api/settings {waitingStaleDays:5}`. It also pins the strict settings validation (unknown key /
 * non-positive value → 400) on the real route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, Thread, TodayReadModel, WsMessage } from '@mailordomo/shared';
import { DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import type { MetadataClient } from '../metadata-client';
import { createFileSettingsStore, SETTINGS_FILE_NAME } from '../settings';
import type { SettingsStore } from '../settings';
import { PROJECT_A, startInProcessServer, type InProcessServer } from '../integration/harness';
import { createBackendApi } from './app';

const DAY_MS = 24 * 60 * 60 * 1000;

let server: InProcessServer;
let client: MetadataClient;
let cache: MessageCache;
let configDir: string;
let settingsFile: string;
let settingsStore: SettingsStore;
let broadcasts: WsMessage[];
let app: ReturnType<typeof createBackendApi>;

beforeEach(() => {
  server = startInProcessServer(PROJECT_A);
  client = server.client(PROJECT_A);
  cache = MessageCache.open({ dbPath: ':memory:' });
  configDir = mkdtempSync(join(tmpdir(), 'mailordomo-app-intent-'));
  settingsFile = join(configDir, SETTINGS_FILE_NAME);
  settingsStore = createFileSettingsStore(settingsFile);
  broadcasts = [];
  app = createBackendApi({
    metadata: client,
    cache,
    settingsStore,
    broadcast: (msg) => broadcasts.push(msg),
  });
});

afterEach(() => {
  server.close();
  cache.close();
  rmSync(configDir, { recursive: true, force: true });
});

/** Seed a single `waiting` thread whose last activity is `agoMs` in the past (real wall clock). */
async function seedWaitingThread(agoMs: number): Promise<Thread> {
  const thread = await client.upsertThread({
    project_id: PROJECT_A.id,
    mailbox_address: 'jan@acme.com',
    root_message_id: '<wiring@acme.com>',
    subject: 'Quarterly report',
    snippet: 'Awaiting your reply',
    sender: 'Petr <petr@acme.com>',
    last_message_at: new Date(Date.now() - agoMs).toISOString(),
  });
  await client.createTask({ thread_id: thread.id, state: 'waiting', importance: 'normal' });
  return thread;
}

async function getToday(): Promise<TodayReadModel> {
  const res = await app.request('/api/today');
  expect(res.status).toBe(200);
  return (await res.json()) as TodayReadModel;
}

describe('GET /api/settings (real app)', () => {
  it('returns the shipped defaults before any write (missing file → defaults)', async () => {
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    expect((await res.json()) as AppSettings).toEqual(DEFAULT_APP_SETTINGS);
  });
});

describe('D27 wiring — a changed stale threshold actually reaches detectStale', () => {
  it('a 4-day-old waiting thread is stale at the default 3d, then NOT stale after PUT {waitingStaleDays:5}', async () => {
    const thread = await seedWaitingThread(4 * DAY_MS);

    // Default thresholds (waiting 3d): 4 days of silence ⇒ stale.
    const before = await getToday();
    const cardBefore = before.doNext.find((c) => c.threadId === thread.id);
    expect(cardBefore).toBeDefined();
    expect(cardBefore?.staleReason).toBe('awaiting-reply-too-long');

    // Raise the waiting threshold to 5 days via the REAL route.
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 5 }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as AppSettings).waitingStaleDays).toBe(5);
    expect(broadcasts).toContainEqual({ type: 'today:changed' }); // clients told to refetch
    // The change is persisted to the local config file (a fresh store sees it).
    expect(createFileSettingsStore(settingsFile).read().waitingStaleDays).toBe(5);

    // Same 4-day-old thread is now WITHIN the (raised) threshold ⇒ no longer stale. This only
    // holds if the new setting actually flowed into `detectStale` on the next assembly.
    const after = await getToday();
    const cardAfter = after.doNext.find((c) => c.threadId === thread.id);
    expect(cardAfter).toBeDefined();
    expect(cardAfter?.staleReason).toBeNull();
  });
});

describe('PUT /api/settings (real app) — strict validation', () => {
  it('rejects an unknown key with 400 and does not broadcast', async () => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 4, nope: true }),
    });
    expect(res.status).toBe(400);
    expect(broadcasts).toEqual([]);
  });

  it('rejects a non-positive threshold with 400', async () => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
