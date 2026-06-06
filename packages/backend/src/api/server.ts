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
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { MailboxConfig, WsMessage } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { RealClaudeRunner, UsageThrottle, throttleConfigFromEnv } from '../claude';
import type { NudgeDraft, NudgeFiledResult } from '../claude';
import { startDaemon } from '../daemon';
import type { DraftFiler } from '../daemon';
import { createFileConfigStore, resolveConfigFilePath } from '../config';
import { resolveCredentialStore } from '../credentials';
import type { CredentialStore } from '../credentials';
import { createFileDraftStore, resolveDraftsDbPath } from '../drafts';
import { ResilientImapConnection } from '../imap/connection';
import { createImapFlowClient } from '../imap/imapflow-client';
import type { ImapClient } from '../imap/types';
import { LearningLog, resolveLearningDir } from '../learning';
import { MetadataClient } from '../metadata-client';
import { createGitRunner } from '../repos';
import { createFileSettingsStore, resolveConfigDir, resolveSettingsFilePath } from '../settings';
import { createNodemailerComposer } from '../smtp/nodemailer';
import { saveDraft } from '../smtp/send';
import type { SendDeps } from '../smtp/send';
import { createStubMailTransport } from '../smtp/stub-transport';
import { createCacheDaemonSource } from '../source';
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
  readonly cacheBlobDir: string;
  readonly settingsFilePath: string;
  readonly actor: string | undefined;
}

function readEnv(env: NodeJS.ProcessEnv = process.env): BackendEnv {
  const portRaw = env['BACKEND_PORT'];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 4317;
  const configDir = resolveConfigDir(env);
  return {
    host: env['BACKEND_HOST'] ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 4317,
    // Accept the env names the README / `.env.example` document (METADATA_SERVICE_URL /
    // METADATA_PROJECT_TOKEN), falling back to the older METADATA_BASE_URL / METADATA_TOKEN aliases.
    metadataBaseUrl:
      env['METADATA_SERVICE_URL'] ?? env['METADATA_BASE_URL'] ?? 'http://127.0.0.1:8787',
    projectId: env['METADATA_PROJECT_ID'] ?? '',
    token: env['METADATA_PROJECT_TOKEN'] ?? env['METADATA_TOKEN'] ?? '',
    // The disposable cache (DB + raw `.eml` blobs) defaults UNDER the config dir so it is co-located,
    // machine-local, and clearly rebuildable. The blob dir is REQUIRED for the daemon to read bodies.
    cacheDbPath: env['CACHE_DB_PATH'] ?? join(configDir, 'cache.sqlite'),
    cacheBlobDir: env['CACHE_BLOB_DIR'] ?? join(configDir, 'cache-blobs'),
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

  // Shared usage throttle (one rolling subscription window across the on-demand digest AND the
  // background daemon, so background work backpressures before it can starve interactive Claude use).
  const throttle = new UsageThrottle(throttleConfigFromEnv());

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

  // Mutable control box, filled below with the live daemon's `runCycleNow` so `POST /api/sync` can
  // trigger an immediate poll→triage cycle. Stays empty when the daemon is off/idle → /api/sync 503s.
  const syncControl: { runCycleNow?: () => void } = {};

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
    throttle,
    configStore,
    credentialStore,
    imapTester,
    gitRunner,
    syncControl,
  });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    console.log(
      `mailordomo-backend api listening on http://${env.host}:${info.port} (ws ${WS_PATH})`,
    );
  });
  ws.server = createTodayWsServer({ server: server as unknown as Server });

  // BACKGROUND DAEMON (Phase 9 / D34, D35) — composed HERE, the composition root, so the sanctioned
  // overdue-nudge `DraftFiler` can wrap `smtp/saveDraft` (this api layer may import smtp; the daemon
  // is lint-barred and receives the filer INJECTED — it has no path to a transport). Started ONLY when
  // `MAILORDOMO_DAEMON=on` (launchd sets it); never auto-started in a dev run or in tests (which
  // import `createBackendApi`, not this entry). The LIVE source (D35) drives a real IMAP poll → cache →
  // enumeration once a mailbox is configured (the setup wizard) with an IMAP password in the
  // CredentialStore — until then the daemon stays idle (logged), waiting on configuration + a restart.
  if ((process.env['MAILORDOMO_DAEMON'] ?? '').toLowerCase() === 'on') {
    void maybeStartDaemon({
      metadata,
      runner,
      throttle,
      sendDeps,
      env,
      cache,
      configStore,
      credentialStore,
      syncControl,
      broadcast,
    }).catch((error: unknown) => console.error('[daemon] failed to start', error));
  }
}

/**
 * The narrow saveDraft-only seam the daemon nudge writes through. Wraps `smtp/saveDraft` (compose +
 * APPEND to Drafts) — it has NO transmit verb, so the daemon (which never imports smtp) cannot send.
 * This binding lives in the composition root by design (Golden rule #1 / PLAN.md §4.6).
 */
function createNudgeDraftFiler(sendDeps: SendDeps, from: string): DraftFiler {
  return {
    async saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult> {
      const result = await saveDraft(
        { from, to: [draft.to], subject: draft.subject, text: draft.body },
        sendDeps,
      );
      return { messageId: result.messageId, filedTo: result.filedTo };
    },
  };
}

/** Parse a positive-int env var, or `undefined` when unset/invalid (so a default applies). */
function readPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Compose + start the background daemon with its LIVE message source (D35): one resilient IMAP
 * connection for the configured mailbox feeds `MailboxSync` → cache → enumeration → the daemon cycle.
 *
 * The daemon goes live ONLY when fully configured: a mailbox in the local config (set by the setup
 * wizard) AND its IMAP password in the CredentialStore AND metadata project creds. Missing any of
 * these, it logs WHY and stays idle (no connection opened) — connect a mailbox and restart the
 * service to make it live. `launchd` runs the process; `MAILORDOMO_DAEMON=on` enables this path. The
 * daemon NEVER sends — the nudge filer is saveDraft-only and the daemon has no transport reference.
 */
async function maybeStartDaemon(deps: {
  metadata: MetadataClient;
  runner: RealClaudeRunner;
  throttle: UsageThrottle;
  sendDeps: SendDeps;
  env: BackendEnv;
  cache: MessageCache;
  configStore: ReturnType<typeof createFileConfigStore>;
  credentialStore: CredentialStore;
  /** Filled with the daemon's `runCycleNow` once live, so `POST /api/sync` can trigger a cycle. */
  syncControl: { runCycleNow?: () => void };
  /** Push a `today:changed` after each cycle so the UI refreshes on background/manual sync. */
  broadcast: (msg: WsMessage) => void;
}): Promise<void> {
  const { metadata, runner, throttle, sendDeps, env, cache, configStore, credentialStore } = deps;
  const { syncControl, broadcast } = deps;
  const fromAddress = process.env['MAILORDOMO_NUDGE_FROM'] ?? metadata.getProjectId();
  const filer = createNudgeDraftFiler(sendDeps, fromAddress);

  // Resolve the single configured mailbox (single-mailbox v1, D32) + the metadata creds.
  const mailbox: MailboxConfig | undefined = configStore.read().mailboxes[0];
  if (mailbox === undefined || env.projectId === '' || env.token === '') {
    console.warn(
      '[daemon] enabled but not fully configured — need a mailbox (run the setup wizard) and ' +
        'METADATA_PROJECT_ID + METADATA_PROJECT_TOKEN. Staying idle until configured + restarted.',
    );
    return;
  }

  // The IMAP password is the ONLY secret read here — straight from the CredentialStore, never logged.
  const imapPassword = await credentialStore.get(mailbox.id, 'imap');
  if (imapPassword === undefined) {
    console.warn(
      `[daemon] no IMAP password stored for mailbox ${mailbox.id} (${mailbox.address}) — run the ` +
        'setup wizard to store credentials, then restart. Staying idle.',
    );
    return;
  }

  // ONE resilient IMAP connection for the watched mailbox (Phase 3): own reconnect/backoff; IDLE keeps
  // it warm so a server `'exists'` push runs a cycle promptly. The source reads the CURRENT client.
  const trigger = { fire: (): void => {} };
  const connection = new ResilientImapConnection({
    clientFactory: (): ImapClient =>
      createImapFlowClient({
        host: mailbox.imap.host,
        port: mailbox.imap.port,
        secure: mailbox.imap.secure,
        auth: { user: mailbox.imap.user, pass: imapPassword },
      }),
    onReady: (client) => {
      // New-mail push → run a cycle now (IDLE-hot). Also kick one cycle on (re)connect so the recent
      // backlog is triaged immediately rather than waiting for the first cold interval.
      client.onExists(() => trigger.fire());
      trigger.fire();
    },
    logger: (message, meta) => console.log(`[daemon imap] ${message}`, meta ?? ''),
  });

  const source = createCacheDaemonSource({
    connection,
    cache,
    metadata,
    mailbox: { address: mailbox.address },
    folders: [{ path: 'INBOX' }],
    projectId: metadata.getProjectId(),
    ...(readPositiveInt(process.env['MAILORDOMO_DAEMON_INITIAL_BACKLOG']) !== undefined
      ? { initialBacklog: readPositiveInt(process.env['MAILORDOMO_DAEMON_INITIAL_BACKLOG']) }
      : {}),
  });

  const intervalMs = readPositiveInt(process.env['MAILORDOMO_DAEMON_INTERVAL_MS']) ?? 5 * 60 * 1000;
  const handle = startDaemon(
    { source, runner, throttle, metadata, filer },
    {
      intervalMs,
      immediate: false, // `onReady` fires the first cycle once the connection is up
      connection,
      onCycle: (result) => {
        console.log('[daemon] cycle complete', result);
        // Nudge connected clients to refetch Today (cold poll + IDLE new-mail + manual /api/sync).
        // Guard the broadcast: `onCycle` runs in the loop's `.then` (NOT covered by its `.catch`), so a
        // throwing WS push would become an unhandled rejection rather than just a missed refresh.
        try {
          broadcast({ type: 'today:changed' });
        } catch (cause) {
          console.error('[daemon] today:changed broadcast failed', cause);
        }
      },
      onError: (error) => console.error('[daemon] cycle error', error),
    },
  );
  trigger.fire = handle.runCycleNow;
  // Expose the live cycle trigger to POST /api/sync (the "Sync now" button).
  syncControl.runCycleNow = handle.runCycleNow;
  console.log(
    `[daemon] live: watching ${mailbox.address} INBOX via ${mailbox.imap.host} ` +
      `(cold poll ${intervalMs}ms, IDLE-hot on new mail).`,
  );
}

main();
