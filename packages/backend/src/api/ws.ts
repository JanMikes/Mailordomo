/**
 * The Today WebSocket server (PLAN.md §7 Phase 7a, open Q #28 / D29).
 *
 * It attaches to the SAME Node `http.Server` that `@hono/node-server`'s `serve()` returns, on the
 * path `/api/ws`, so the REST API and the socket share one loopback port (127.0.0.1; never public).
 * Its only job is to push a lightweight `{type:'today:changed'}` frame when the Today data changes
 * server-side — the client then refetches `GET /api/today`. No metadata (and certainly no body) ever
 * travels over the socket; the frame is just a change signal. `broadcast` is hardened to never throw
 * on a closed/closing client.
 *
 * It is small and INJECTABLE: the test-author constructs an `http.Server`, attaches this, connects a
 * `ws` client, and asserts the broadcast/heartbeat behavior with no real backend.
 */
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { WsMessage } from '@mailordomo/shared';
import { WsMessageSchema } from '@mailordomo/shared';

/** The WS endpoint path (matches the Vite `/api` proxy with `ws:true`). */
export const WS_PATH = '/api/ws';

/** Default protocol-level heartbeat interval (ms). A client that misses a pong is terminated. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export interface TodayWsServer {
  /** Send `msg` to every OPEN client. Never throws (a closed socket is skipped). */
  broadcast(msg: WsMessage): void;
  /** Stop the heartbeat and close the server (for tests / shutdown). */
  close(): void;
  /** The underlying `ws` server (exposed for tests/inspection). */
  readonly wss: WebSocketServer;
}

export interface CreateWsServerOptions {
  /** The Node HTTP server to attach to (the handle returned by `@hono/node-server` `serve()`). */
  readonly server: Server;
  /** Override the WS path (default {@link WS_PATH}). */
  readonly path?: string;
  /** Override the heartbeat interval (default {@link DEFAULT_HEARTBEAT_MS}). */
  readonly heartbeatMs?: number;
}

/**
 * Create a {@link TodayWsServer} attached to `options.server`. Tracks per-client liveness with a
 * `WeakSet` (marked on pong, cleared before each ping; an unmarked client missed the last ping and is
 * terminated) and answers an application-level `{type:'ping'}` with `{type:'pong'}`.
 */
export function createTodayWsServer(options: CreateWsServerOptions): TodayWsServer {
  const wss = new WebSocketServer({ server: options.server, path: options.path ?? WS_PATH });
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const alive = new WeakSet<WebSocket>();

  wss.on('connection', (socket: WebSocket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.on('message', (data) => {
      // Best-effort: ignore non-JSON / unknown frames; only the app-level ping→pong matters here.
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = WsMessageSchema.safeParse(json);
      if (parsed.success && parsed.data.type === 'ping') {
        sendSafe(socket, { type: 'pong' });
      }
    });
  });

  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      try {
        socket.ping();
      } catch {
        // Socket closed between the readyState check and the ping — ignore.
      }
    }
  }, heartbeatMs);
  // Don't keep the process alive solely for the heartbeat.
  timer.unref();

  function broadcast(msg: WsMessage): void {
    const payload = JSON.stringify(msg);
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // Never throw on a closed/closing socket — skip it.
        }
      }
    }
  }

  function close(): void {
    clearInterval(timer);
    wss.close();
  }

  return { broadcast, close, wss };
}

/** Send a {@link WsMessage} to one socket, swallowing any closed-socket error. */
function sendSafe(socket: WebSocket, msg: WsMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    // closed mid-send — ignore.
  }
}
