/**
 * Runnable entry for the thin localhost backend API (PLAN.md §7 Phase 4.5). Wires a real
 * {@link MetadataClient} + {@link MessageCache} into {@link createBackendApi} and serves it on
 * loopback ONLY (`BACKEND_HOST`/`BACKEND_PORT`, default 127.0.0.1:4317 — PLAN.md open Q #28; never a
 * public interface). The Vite dev server proxies `/api` here.
 *
 * Config is read from the environment (a later phase's setup wizard / `{mailbox}.env` will populate
 * it). Missing metadata creds are NOT fatal: the app still starts and `GET /api/wiring` simply
 * reports the metadataService layer red — which is exactly the diagnostic this endpoint exists for.
 */
import { serve } from '@hono/node-server';
import { MessageCache } from '../cache';
import { MetadataClient } from '../metadata-client';
import { createBackendApi } from './app';

interface BackendEnv {
  readonly host: string;
  readonly port: number;
  readonly metadataBaseUrl: string;
  readonly projectId: string;
  readonly token: string;
  readonly cacheDbPath: string;
  readonly cacheBlobDir: string | undefined;
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
  const app = createBackendApi({ metadata, cache });
  serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(`mailordomo-backend api listening on http://${env.host}:${info.port}`);
  });
}

main();
