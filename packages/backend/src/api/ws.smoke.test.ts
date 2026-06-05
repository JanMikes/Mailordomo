/**
 * SMOKE — the Today {@link createTodayWsServer} (D29). Thin coverage: a broadcast reaches a connected
 * client, an app-level ping is answered with a pong, and a broadcast with no clients never throws.
 * The full heartbeat/terminate suite is the separate test-author's job.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createTodayWsServer, WS_PATH } from './ws';
import type { TodayWsServer } from './ws';

let server: Server | undefined;
let ws: TodayWsServer | undefined;

afterEach(async () => {
  ws?.close();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  ws = undefined;
});

/** Start an HTTP server with the WS attached; resolve the loopback URL of the WS endpoint. */
async function start(): Promise<string> {
  server = createServer();
  // Long heartbeat so it never interferes with the assertion; `timer.unref()` keeps it from hanging.
  ws = createTodayWsServer({ server, heartbeatMs: 60_000 });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

/** Open a `ws` client and wait until it is connected. */
async function connect(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return client;
}

/** The next message a client receives, parsed as JSON. */
function nextMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    client.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
}

describe('createTodayWsServer', () => {
  it('broadcasts today:changed to a connected client', async () => {
    const url = await start();
    const client = await connect(url);
    const got = nextMessage(client);
    ws?.broadcast({ type: 'today:changed' });
    expect(await got).toEqual({ type: 'today:changed' });
    client.close();
  });

  it('answers an application-level ping with a pong', async () => {
    const url = await start();
    const client = await connect(url);
    const got = nextMessage(client);
    client.send(JSON.stringify({ type: 'ping' }));
    expect(await got).toEqual({ type: 'pong' });
    client.close();
  });

  it('broadcast with no clients does not throw', async () => {
    await start();
    expect(() => ws?.broadcast({ type: 'today:changed' })).not.toThrow();
  });
});
