/**
 * The Today live-update socket (PLAN.md §7 Phase 7a / D29). Connects to the backend WS through the
 * Vite `/api` proxy (`ws:true`), and on a `{type:'today:changed'}` frame invokes `onChanged` (the
 * caller invalidates `['today']`, refetching the view). It replies `pong` to an app-level `ping` and
 * reconnects with capped exponential backoff + jitter, cleaning everything up on unmount.
 *
 * NO payload ever crosses this socket — it is a pure change signal (the model is fetched over REST),
 * so nothing here can leak metadata or a body.
 */
import { useEffect, useRef } from 'react';
import { WsMessageSchema } from '@mailordomo/shared';

const WS_PATH = '/api/ws';
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const JITTER_MS = 250;

/** Resolve the WS URL from the current page origin (same host the `/api` REST proxy uses). */
function wsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${WS_PATH}`;
}

/**
 * Subscribe to Today change pushes for the lifetime of the calling component. `onChanged` may change
 * between renders without re-opening the socket (it is read through a ref).
 */
export function useWsToday(onChanged: () => void): void {
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    function scheduleReconnect(): void {
      if (disposed) return;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, backoff + Math.random() * JITTER_MS);
    }

    function connect(): void {
      if (disposed) return;
      const ws = new WebSocket(wsUrl());
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          return;
        }
        const parsed = WsMessageSchema.safeParse(json);
        if (!parsed.success) return;
        if (parsed.data.type === 'today:changed') {
          onChangedRef.current();
        } else if (parsed.data.type === 'ping') {
          try {
            ws.send(JSON.stringify({ type: 'pong' }));
          } catch {
            // socket closed mid-reply — the reconnect path will handle it
          }
        }
      };
      ws.onerror = () => {
        // Surface as a close so a single path (onclose) owns reconnection.
        ws.close();
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        scheduleReconnect();
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (socket) {
        // Drop the handler first so closing doesn't schedule a post-unmount reconnect.
        socket.onclose = null;
        socket.close();
        socket = null;
      }
    };
  }, []);
}
