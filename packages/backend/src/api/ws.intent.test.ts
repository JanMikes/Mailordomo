/**
 * INTENT (separate test-author) — the Today live-update socket wiring (PLAN.md D29). ADDITIVE to
 * `ws.smoke.test.ts`. Uses a real `http.Server` + the `ws` server + real `ws` clients (no mocks).
 *
 * It pins: (1) a `PUT /api/settings` through the REAL backend reaches a connected client as
 * `today:changed` (the broadcast is wired end-to-end, not just callable); (2) a disconnected client
 * never makes `broadcast()` throw and never starves the other client; (3) the protocol heartbeat ping
 * fires and a responsive client survives it; (4) the app-level `ping`→`pong` reply, while an unknown
 * frame is silently ignored (the discriminated-union guard).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { AppSettings, WsMessage } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import type { SettingsStore } from '../settings';
import { createBackendApi } from './app';
import { createTodayWsServer, WS_PATH, type TodayWsServer } from './ws';

let server: Server | undefined;
let ws: TodayWsServer | undefined;
let cache: MessageCache | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  ws?.close();
  cache?.close();
  cache = undefined;
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  ws = undefined;
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Start an HTTP server with the WS attached; resolve the loopback URL of the WS endpoint. */
async function start(heartbeatMs = 60_000): Promise<string> {
  server = createServer();
  ws = createTodayWsServer({ server, heartbeatMs });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

async function connect(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  return client;
}

function nextMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    client.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await delay(5);
  }
}

/** An in-memory settings store (the file store has its own suite). */
function memStore(): SettingsStore {
  let current: AppSettings = { ...DEFAULT_APP_SETTINGS };
  return {
    read: () => current,
    write: (patch) => {
      current = AppSettingsSchema.parse({ ...current, ...patch });
      return current;
    },
  };
}

/** A metadata client pointed at a dead URL — fine here (the settings route never touches metadata). */
function deadClient(): MetadataClient {
  return new MetadataClient({ baseUrl: 'http://unused.local', projectId: 'p', token: 't' });
}

describe('Today WS — PUT /api/settings pushes today:changed to a connected client', () => {
  it('a real backend PUT broadcasts over the real socket', async () => {
    const url = await start();
    const client = await connect(url);
    cache = MessageCache.open({ dbPath: ':memory:' });
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      broadcast: (msg) => ws?.broadcast(msg),
    });

    const got = nextMessage(client);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingStaleDays: 7 }),
    });
    expect(res.status).toBe(200);
    expect(await got).toEqual({ type: 'today:changed' });
  });
});

describe('Today WS — robustness with a disconnected client', () => {
  it('a closed client never makes broadcast throw and never starves the other client', async () => {
    const url = await start();
    const c1 = await connect(url);
    const c2 = await connect(url);
    await waitFor(() => (ws?.wss.clients.size ?? 0) === 2);

    c1.close();
    await waitFor(() => (ws?.wss.clients.size ?? 0) === 1); // server registered the disconnect

    const got2 = nextMessage(c2);
    expect(() => ws?.broadcast({ type: 'today:changed' })).not.toThrow();
    expect(await got2).toEqual({ type: 'today:changed' });
  });
});

describe('Today WS — heartbeat', () => {
  it('sends a protocol ping; a responsive client survives across intervals', async () => {
    const url = await start(40);
    const client = await connect(url);

    await new Promise<void>((resolve) => client.once('ping', () => resolve())); // server pinged us
    await delay(150); // several more intervals; the client auto-pongs, so it is never terminated
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});

describe('Today WS — application-level ping/pong + unknown-frame guard', () => {
  it('replies pong to a ping and silently ignores a non-JSON frame', async () => {
    const url = await start();
    const client = await connect(url);

    const got = nextMessage(client);
    client.send('this is not json at all'); // must be ignored (no reply, no crash)
    client.send(JSON.stringify({ type: 'ping' } satisfies WsMessage));
    // The first (and only) frame back is the pong — the garbage produced nothing.
    expect(await got).toEqual({ type: 'pong' });
  });
});
