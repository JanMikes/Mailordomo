/**
 * Phase 4.5 WIRING VIEW (PLAN.md §7). This is deliberately un-styled — it exists only to prove the
 * frontend ↔ backend ↔ (metadata service · cache · claude) chain is alive end-to-end. The real UI
 * (Today command center, split work surface, 3-pane fallback) with Tailwind + shadcn/ui + Lucide
 * lands in Phase 7.
 *
 * On mount it calls `GET /api/wiring` (the three-layer health report) and `GET /api/threads` (a
 * count of cached threads). The Vite dev server proxies `/api` → the backend on 127.0.0.1:4317
 * (see `vite.config.ts`), so these are same-origin fetches in dev. Bodies never leave the machine;
 * `/api/threads` is metadata only.
 */
import { useEffect, useState } from 'react';

/** Mirrors the backend `WiringStatus` (one layer's health). Localhost HTTP shape, not a shared DTO. */
interface LayerStatus {
  ok: boolean;
  detail: string;
}

/** Mirrors the backend `WiringReport`. */
interface WiringReport {
  metadataService: LayerStatus;
  cache: LayerStatus;
  claude: LayerStatus;
}

/** Mirrors the backend `ThreadsResponse` (we only render the count here). */
interface ThreadsResponse {
  count: number;
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

function LayerRow({ name, status }: { name: string; status: LayerStatus }) {
  return (
    <li style={{ margin: '4px 0' }}>
      <span style={{ color: status.ok ? 'green' : 'red', fontWeight: 600 }}>
        {status.ok ? '●' : '○'} {name}
      </span>{' '}
      — <span>{status.ok ? 'ok' : 'down'}</span>: <span>{status.detail}</span>
    </li>
  );
}

export function App() {
  const [wiring, setWiring] = useState<LoadState<WiringReport>>({ status: 'loading' });
  const [threads, setThreads] = useState<LoadState<ThreadsResponse>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getJson<WiringReport>('/api/wiring')
      .then((data) => {
        if (!cancelled) setWiring({ status: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setWiring({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });

    getJson<ThreadsResponse>('/api/threads')
      .then((data) => {
        if (!cancelled) setThreads({ status: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setThreads({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 640 }}>
      <h1>Mailordomo — wiring check</h1>

      <section>
        <h2>Three layers</h2>
        {wiring.status === 'loading' && <p>Checking…</p>}
        {wiring.status === 'error' && (
          <p style={{ color: 'red' }}>Could not reach backend: {wiring.message}</p>
        )}
        {wiring.status === 'ok' && (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            <LayerRow name="Metadata service" status={wiring.data.metadataService} />
            <LayerRow name="Local cache" status={wiring.data.cache} />
            <LayerRow name="Claude binary" status={wiring.data.claude} />
          </ul>
        )}
      </section>

      <section>
        <h2>Cached threads</h2>
        {threads.status === 'loading' && <p>Loading…</p>}
        {threads.status === 'error' && (
          <p style={{ color: 'red' }}>Could not load threads: {threads.message}</p>
        )}
        {threads.status === 'ok' && <p>{threads.data.count} cached thread(s)</p>}
      </section>
    </main>
  );
}
