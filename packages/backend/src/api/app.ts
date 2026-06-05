/**
 * The thin localhost backend API (PLAN.md §7 Phase 4.5 + 7a). A minimal Hono app that proves the
 * three layers wire together and feeds the frontend the Today command center. It mirrors the
 * server's `createApp` pattern: `createBackendApi(deps)` takes its dependencies INJECTED (the
 * {@link MetadataClient} + {@link MessageCache} + {@link SettingsStore} + an optional WS `broadcast`),
 * so the whole API is testable in-process without binding a socket, spawning `claude`, or the network.
 *
 * Bound to 127.0.0.1 by the runnable entry (`server.ts`) — never a public interface (PLAN.md open
 * Q #28). Endpoints:
 *  - GET  /api/wiring               → three-layer wiring report ({metadataService, cache, claude}).
 *  - GET  /api/threads              → cached threads (subject/snippet/sender metadata only).
 *  - GET  /api/today                → the assembled Today read model (metrics + counts + do-next).
 *  - GET  /api/settings             → the local app settings.
 *  - PUT  /api/settings             → patch the local app settings (broadcasts `today:changed`).
 *  - POST /api/tasks/:threadId/done → mark the thread's task done (metadata transition).
 *  - POST /api/tasks/:threadId/snooze → set the task's follow_up_at (metadata write).
 *
 * GOLDEN RULE #1 (sending is ALWAYS manual): there is NO send path here. The inline actions are
 * METADATA WRITES ONLY (a task transition / a follow_up_at edit). Nothing under `smtp/` is imported.
 */
import { Hono } from 'hono';
import type { WsMessage } from '@mailordomo/shared';
import { IsoDateTimeSchema, UpdateSettingsRequestSchema } from '@mailordomo/shared';
import type { MessageCache } from '../cache';
import type { MetadataClient } from '../metadata-client';
import type { SettingsStore } from '../settings';
import type { WiringReport, WiringStatus } from './wiring';
import { checkCache, checkClaude, checkMetadata } from './wiring';
import { listCachedThreads } from './threads-view';
import type { ThreadListItem } from './threads-view';
import { assembleTodayView } from './today-view';

/** Actor recorded on inline task transitions when none is configured. Phase 8's wizard sets the real one. */
export const DEFAULT_LOCAL_ACTOR = 'me';

/** Default snooze: push `follow_up_at` 24h out when the request body omits an explicit time. */
const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface BackendApiDeps {
  /** The metadata-service client (its `pair()` backs the metadataService wiring check). */
  readonly metadata: MetadataClient;
  /** The disposable local cache (its open-ness backs the cache check + feeds `/api/threads`). */
  readonly cache: MessageCache;
  /** The local settings store (backs `GET`/`PUT /api/settings`; feeds the Today stale thresholds). */
  readonly settingsStore: SettingsStore;
  /**
   * Push a WS message after a mutation so connected clients refetch (default: no-op). The runnable
   * entry wires this to the {@link createTodayWsServer} broadcaster; tests inject a spy.
   */
  readonly broadcast?: (msg: WsMessage) => void;
  /** Actor attributed to inline transitions (default {@link DEFAULT_LOCAL_ACTOR}). */
  readonly actor?: string;
  /** Override the metadataService check (default: `checkMetadata(metadata)` → `metadata.pair()`). */
  readonly checkMetadata?: () => Promise<WiringStatus>;
  /** Override the claude check (default: `checkClaude()` → `CLAUDE_BIN` / `which claude`). */
  readonly checkClaude?: () => Promise<WiringStatus>;
}

/** The JSON body of `GET /api/threads`. */
export interface ThreadsResponse {
  readonly threads: readonly ThreadListItem[];
  readonly count: number;
}

/** The JSON body of `POST /api/tasks/:threadId/done`. */
export interface MarkDoneResponse {
  readonly threadId: string;
  readonly state: 'done';
  /** `false` when the thread already had no non-done task (idempotent no-op, no broadcast). */
  readonly changed: boolean;
}

export function createBackendApi(deps: BackendApiDeps): Hono {
  const { cache, metadata, settingsStore } = deps;
  const broadcast = deps.broadcast ?? ((): void => {});
  const actor = deps.actor ?? DEFAULT_LOCAL_ACTOR;
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

  /**
   * The Today command center. Fetches tasks/threads/promises/drafts from the metadata service
   * CONCURRENTLY and assembles the read model with the CURRENT settings. Degrades gracefully: a
   * failed metadata call logs + yields an empty slice rather than 500-ing the whole view.
   */
  app.get('/api/today', async (c) => {
    const [tasks, threads, promises, draftMeta] = await Promise.all([
      metadata.listTasks().catch(emptyOnError('tasks')),
      metadata.listThreads().catch(emptyOnError('threads')),
      metadata.listPromises().catch(emptyOnError('promises')),
      metadata.listDraftMeta().catch(emptyOnError('drafts')),
    ]);
    const model = assembleTodayView(
      {
        projectId: metadata.getProjectId(),
        tasks,
        threads,
        promises,
        draftMeta,
        settings: settingsStore.read(),
      },
      new Date().toISOString(),
    );
    return c.json(model, 200);
  });

  /** Read the local app settings. */
  app.get('/api/settings', (c) => c.json(settingsStore.read(), 200));

  /**
   * Patch the local app settings (stale thresholds / lock timeout / color scheme). Validates the
   * patch (strict — rejects unknown keys), persists it, and broadcasts `today:changed` so clients
   * pick up a changed stale threshold immediately.
   */
  app.put('/api/settings', async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = UpdateSettingsRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid settings patch', code: 'invalid' }, 400);
    }
    const updated = settingsStore.write(parsed.data);
    broadcast({ type: 'today:changed' });
    return c.json(updated, 200);
  });

  /**
   * Mark the thread's task done — a metadata state transition (NOT a send). Picks the thread's first
   * non-done task and transitions it to `done`; if every task is already done it is an idempotent
   * no-op. 404 when the thread has no task at all.
   */
  app.post('/api/tasks/:threadId/done', async (c) => {
    const threadId = c.req.param('threadId');
    const tasks = await metadata.listTasks(threadId);
    if (tasks.length === 0) {
      return c.json({ error: 'no task for thread', code: 'not_found' }, 404);
    }
    const target = tasks.find((t) => t.state !== 'done');
    if (target === undefined) {
      const body: MarkDoneResponse = { threadId, state: 'done', changed: false };
      return c.json(body, 200);
    }
    await metadata.createTransition(target.id, { to: 'done', actor });
    broadcast({ type: 'today:changed' });
    const body: MarkDoneResponse = { threadId, state: 'done', changed: true };
    return c.json(body, 200);
  });

  /**
   * Snooze the thread's task — set its `follow_up_at` (a metadata write). Accepts an optional
   * `{ follow_up_at: <ISO> }`; defaults to 24h out. 404 when the thread has no task.
   */
  app.post('/api/tasks/:threadId/snooze', async (c) => {
    const threadId = c.req.param('threadId');
    const raw = (await c.req.json().catch(() => undefined)) as
      | { follow_up_at?: unknown }
      | undefined;
    let followUpAt: string;
    if (raw?.follow_up_at === undefined) {
      followUpAt = new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString();
    } else {
      const parsed = IsoDateTimeSchema.safeParse(raw.follow_up_at);
      if (!parsed.success) {
        return c.json({ error: 'invalid follow_up_at', code: 'invalid' }, 400);
      }
      followUpAt = parsed.data;
    }
    const tasks = await metadata.listTasks(threadId);
    const target = tasks.find((t) => t.state !== 'done') ?? tasks[0];
    if (target === undefined) {
      return c.json({ error: 'no task for thread', code: 'not_found' }, 404);
    }
    const task = await metadata.updateTask(target.id, { follow_up_at: followUpAt });
    broadcast({ type: 'today:changed' });
    return c.json(task, 200);
  });

  return app;
}

/**
 * Build a `.catch` handler for a Today metadata fetch: log the failure and substitute an empty slice,
 * so one down call degrades that slice rather than failing the whole view. `never[]` is assignable to
 * any element type, so the typed `Promise.all` tuple is preserved.
 */
function emptyOnError(label: string): (cause: unknown) => never[] {
  return (cause: unknown): never[] => {
    console.error(`/api/today: ${label} fetch failed`, cause);
    return [];
  };
}
