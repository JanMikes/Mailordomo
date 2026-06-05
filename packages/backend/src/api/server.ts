/**
 * Runnable entry for the thin localhost backend API (PLAN.md §7 Phase 4.5 + 7a). Wires a real
 * {@link MetadataClient} + {@link MessageCache} + file {@link SettingsStore} into
 * {@link createBackendApi}, then attaches the Today {@link createTodayWsServer} to the SAME Node
 * HTTP server `serve()` returns, and serves it on loopback ONLY (`BACKEND_HOST`/`BACKEND_PORT`,
 * default 127.0.0.1:4317 — PLAN.md open Q #28; never a public interface). The Vite dev server proxies
 * `/api` (REST + WS) here.
 *
 * Config is read from the environment (a later phase's setup wizard / `{mailbox}.env` will populate
 * it). Missing metadata creds are NOT fatal: the app still starts and `GET /api/wiring` simply
 * reports the metadataService layer red — which is exactly the diagnostic this endpoint exists for.
 */
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { WsMessage } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import { createFileSettingsStore, resolveSettingsFilePath } from '../settings';
import { createBackendApi } from './app';
import { createTodayWsServer, WS_PATH } from './ws';
import type { TodayWsServer } from './ws';

interface BackendEnv {
  readonly host: string;
  readonly port: number;
  readonly metadataBaseUrl: string;
  readonly projectId: string;
  readonly token: string;
  readonly cacheDbPath: string;
  readonly cacheBlobDir: string | undefined;
  readonly settingsFilePath: string;
  readonly actor: string | undefined;
}

function readEnv(env: NodeJS.ProcessEnv = process.env): BackendEnv {
  const portRaw = env['BACKEND_PORT'];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 4317;
  return {
    host: env['BACKEND_HOST'] ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 4317,
    metadataBaseUrl: env['METADATA_BASE_URL'] ?? 'http://127.0.0.1:8787',
    projectId: env['METADATA_PROJECT_ID'] ?? '',
    token: env['METADATA_TOKEN'] ?? '',
    // A disposable cache; defaults to a local file so a standalone run shows real folders/threads.
    cacheDbPath: env['CACHE_DB_PATH'] ?? '.mailordomo-cache.sqlite',
    cacheBlobDir: env['CACHE_BLOB_DIR'],
    // Local settings file: $MAILORDOMO_CONFIG_DIR/settings.json (default ~/.mailordomo/).
    settingsFilePath: resolveSettingsFilePath(env),
    // Actor attributed to inline task transitions (the local user); createBackendApi defaults it.
    actor: env['METADATA_ACTOR'],
  };
}

function main(): void {
  const env = readEnv();
  const cache = MessageCache.open({ dbPath: env.cacheDbPath, blobDir: env.cacheBlobDir });
  const metadata = new MetadataClient({
    baseUrl: env.metadataBaseUrl,
    projectId: env.projectId,
    token: env.token,
  });
  const settingsStore = createFileSettingsStore(env.settingsFilePath);

  // The WS server can only be built AFTER `serve()` hands back the HTTP server, but the API needs a
  // `broadcast` now — so route through a stable closure that delegates to the (later) WS server, held
  // in a const box (the box is const; its slot is filled once the socket exists).
  const ws: { server?: TodayWsServer } = {};
  const broadcast = (msg: WsMessage): void => {
    ws.server?.broadcast(msg);
  };

  const app = createBackendApi({ metadata, cache, settingsStore, broadcast, actor: env.actor });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(
      `mailordomo-backend api listening on http://${env.host}:${info.port} (ws ${WS_PATH})`,
    );
  });
  ws.server = createTodayWsServer({ server: server as unknown as Server });
}

main();
