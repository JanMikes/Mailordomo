/**
 * The thin localhost backend API (PLAN.md §7 Phase 4.5). A minimal Hono app that proves the three
 * layers wire together and feeds the frontend something real. It mirrors the server's `createApp`
 * pattern: `createBackendApi(deps)` takes its dependencies INJECTED (the {@link MetadataClient} +
 * {@link MessageCache}, plus overridable health checks), so the whole API is testable in-process
 * without binding a socket, spawning `claude`, or hitting the network.
 *
 * Bound to 127.0.0.1 by the runnable entry (`server.ts`) — never a public interface (PLAN.md open
 * Q #28). Endpoints:
 *  - GET /api/wiring  → the three-layer wiring report ({metadataService, cache, claude}, each
 *                       {ok, detail}). Never throws; a down layer is `ok:false` with the reason.
 *  - GET /api/threads → a small list of cached threads (subject/snippet/sender metadata only —
 *                       Golden rule #3; bodies NEVER leave).
 */
import { Hono } from 'hono';
import type { MessageCache } from '../cache';
import type { MetadataClient } from '../metadata-client';
import type { WiringReport, WiringStatus } from './wiring';
import { checkCache, checkClaude, checkMetadata } from './wiring';
import { listCachedThreads } from './threads-view';
import type { ThreadListItem } from './threads-view';

export interface BackendApiDeps {
  /** The metadata-service client (its `pair()` backs the metadataService wiring check). */
  readonly metadata: MetadataClient;
  /** The disposable local cache (its open-ness backs the cache check + feeds `/api/threads`). */
  readonly cache: MessageCache;
  /**
   * Override the metadataService check (default: `checkMetadata(metadata)` → `metadata.pair()`).
   * Injectable so a test can assert a green/red layer without a live server.
   */
  readonly checkMetadata?: () => Promise<WiringStatus>;
  /** Override the claude check (default: `checkClaude()` → `CLAUDE_BIN` / `which claude`). */
  readonly checkClaude?: () => Promise<WiringStatus>;
}

/** The JSON body of `GET /api/threads`. */
export interface ThreadsResponse {
  readonly threads: readonly ThreadListItem[];
  readonly count: number;
}

export function createBackendApi(deps: BackendApiDeps): Hono {
  const { cache, metadata } = deps;
  const metadataCheck = deps.checkMetadata ?? (() => checkMetadata(metadata));
  const claudeCheck = deps.checkClaude ?? (() => checkClaude());

  const app = new Hono();

  app.onError((err, c) => {
    console.error('backend api error', err);
    return c.json({ error: 'internal server error' }, 500);
  });

  /**
   * Three-layer wiring report. The two async checks run in PARALLEL; each is individually guarded
   * to `ok:false` so one slow/failing layer never blocks or breaks the others.
   */
  app.get('/api/wiring', async (c) => {
    const [metadataService, claude] = await Promise.all([
      metadataCheck().catch((cause: unknown) => ({
        ok: false,
        detail: `check threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      })),
      claudeCheck().catch((cause: unknown) => ({
        ok: false,
        detail: `check threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      })),
    ]);
    const report: WiringReport = { metadataService, cache: checkCache(cache), claude };
    return c.json(report, 200);
  });

  /** Cached threads — metadata only, most-recent-first. */
  app.get('/api/threads', (c) => {
    const threads = listCachedThreads(cache);
    const body: ThreadsResponse = { threads, count: threads.length };
    return c.json(body, 200);
  });

  return app;
}
