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
import { RealClaudeRunner } from '../claude';
import { createFileConfigStore, resolveConfigFilePath } from '../config';
import { resolveCredentialStore } from '../credentials';
import { createFileDraftStore, resolveDraftsDbPath } from '../drafts';
import { LearningLog, resolveLearningDir } from '../learning';
import { MetadataClient } from '../metadata-client';
import { createGitRunner } from '../repos';
import { createFileSettingsStore, resolveSettingsFilePath } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import type { SendDeps } from '../smtp/send';
import { createStubMailTransport } from '../smtp/stub-transport';
import { ToneStore, resolveToneDir } from '../tone';
import { createBackendApi } from './app';
import { createImapConnectionTester } from './test-connection';
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

  // Phase 7b work-surface deps. All are LOCAL (no creds needed yet): the Claude runner (draft/refine
  // Opus + pinned summary Sonnet), the LOCAL-only draft store (never synced), layered tone memory,
  // the learning changelog (revert snapshots), and the send path — with a STUB transport (D30; Phase
  // 8 swaps in real nodemailer + creds). The composer is real (in-process MIME compose, no network).
  // These resolvers read their OWN env vars (MAILORDOMO_CONFIG_DIR / TONE_DIR / LEARNING_DIR) from
  // process.env — not the already-parsed BackendEnv — so call them with the process environment.
  const runner = new RealClaudeRunner();
  const draftStore = createFileDraftStore(resolveDraftsDbPath(process.env));
  const toneStore = ToneStore.open({ dir: resolveToneDir(process.env), projectId: env.projectId });
  const learningLog = LearningLog.open({ dir: resolveLearningDir(process.env) });
  const sendDeps: SendDeps = {
    composer: createNodemailerComposer(),
    transport: createStubMailTransport(),
  };

  // Phase 8 setup-wizard deps: the LOCAL non-secret config store, the CredentialStore (Keychain-first;
  // the ONLY home for secrets — Golden rule #4), the read-only IMAP connection tester, and the git
  // seam for read-only repo mirrors. No background sync/pull loop is started here (that is Phase 9).
  const configStore = createFileConfigStore(resolveConfigFilePath(process.env));
  const credentialStore = resolveCredentialStore(process.env);
  const imapTester = createImapConnectionTester();
  const gitRunner = createGitRunner();

  // The WS server can only be built AFTER `serve()` hands back the HTTP server, but the API needs a
  // `broadcast` now — so route through a stable closure that delegates to the (later) WS server, held
  // in a const box (the box is const; its slot is filled once the socket exists).
  const ws: { server?: TodayWsServer } = {};
  const broadcast = (msg: WsMessage): void => {
    ws.server?.broadcast(msg);
  };

  const app = createBackendApi({
    metadata,
    cache,
    settingsStore,
    broadcast,
    actor: env.actor,
    runner,
    draftStore,
    toneStore,
    learningLog,
    sendDeps,
    configStore,
    credentialStore,
    imapTester,
    gitRunner,
  });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(
      `mailordomo-backend api listening on http://${env.host}:${info.port} (ws ${WS_PATH})`,
    );
  });
  ws.server = createTodayWsServer({ server: server as unknown as Server });
}

main();
