/**
 * The thin localhost backend API (PLAN.md §7 Phase 4.5 + 7a + 7b). A minimal Hono app that proves the
 * three layers wire together, feeds the frontend the Today command center, AND serves the split work
 * surface (thread detail + draft + refine chat + manual send). It mirrors the server's `createApp`
 * pattern: `createBackendApi(deps)` takes its dependencies INJECTED, so the whole API is testable
 * in-process without binding a socket, spawning `claude`, or the network. New 7b deps are OPTIONAL —
 * an endpoint whose dep is unconfigured returns a clean 503 rather than throwing.
 *
 * Bound to 127.0.0.1 by the runnable entry (`server.ts`) — never a public interface (PLAN.md open
 * Q #28). Endpoints (7b additions marked ★):
 *  - GET  /api/wiring               → three-layer wiring report.
 *  - GET  /api/threads              → cached threads (subject/snippet/sender metadata only).
 *  - GET  /api/today                → the assembled Today read model.
 *  - GET  /api/settings · PUT       → read / patch the local app settings.
 *  - POST /api/tasks/:threadId/done · /snooze → metadata-only inline actions.
 *  ★ GET  /api/threads/:threadId                              → body-free ThreadDetail (left pane).
 *  ★ GET  /api/threads/:threadId/messages/:messageId/body     → { body } (LOCAL only; parsed `.eml`).
 *  ★ POST /api/threads/:threadId/draft                        → generate a draft (body LOCAL; DraftMeta on server).
 *  ★ POST /api/threads/:threadId/draft/refine                 → replay + regenerate (golden rule #5).
 *  ★ GET  /api/threads/:threadId/draft                        → current local draft (body + transcript).
 *  ★ POST /api/threads/:threadId/send                         → MANUAL SEND (golden rule #1).
 *  ★ POST /api/threads/:threadId/lock/acquire · /refresh · /release → thread presence locks.
 *  ★ GET  /api/learning · POST /api/learning/:id/revert       → learning changelog + LIFO-guarded revert.
 *
 * GOLDEN RULES enforced here:
 *  - #1 (manual send): the ONLY transmission is `POST …/send`, which calls `smtp/sendReply` with a
 *    STUB transport on an EXPLICIT user POST. This `api/` layer is the only one permitted to import
 *    `smtp/**`; the daemon + learning are lint-barred and have no path to this handler.
 *  - #3 (bodies never leave): draft bodies + refine transcripts live ONLY in the local `DraftStore`;
 *    `createDraftMeta` carries version/model/author only (strict DTO rejects a body). The `…/body`
 *    and `…/draft` GETs are localhost-only and never reach the metadata server.
 */
import { Hono } from 'hono';
import type { Lock, Thread, WsMessage } from '@mailordomo/shared';
import {
  AUTOMATED_ACTOR,
  IsoDateTimeSchema,
  UpdateSettingsRequestSchema,
} from '@mailordomo/shared';
import type { MessageCache, MessageRow } from '../cache';
import type { ClaudeRunner, DraftContext } from '../claude';
import { generateDraft, refineDraft, summarizeThread } from '../claude';
import type { DraftStore } from '../drafts';
import type { LearningDeps, LearningLog } from '../learning';
import { applyLearning, draftVsSentDiff, revertLearning } from '../learning';
import { MetadataError } from '../metadata-client';
import type { MetadataClient } from '../metadata-client';
import type { SettingsStore } from '../settings';
import { sendReply } from '../smtp/send';
import type { OutgoingMessage, ReplyParent, SendDeps } from '../smtp/send';
import type { ToneStore } from '../tone';
import { extractEmail, withDraftToneFile } from './draft-tone';
import {
  buildThreadDetail,
  collectThreadRows,
  findRowByMessageId,
  loadThreadMessageInputs,
  renderMessageBody,
} from './thread-detail-view';
import type { WiringReport, WiringStatus } from './wiring';
import { checkCache, checkClaude, checkMetadata } from './wiring';
import { listCachedThreads } from './threads-view';
import type { ThreadListItem } from './threads-view';
import { assembleTodayView } from './today-view';

/** Actor recorded on inline task transitions when none is configured. Phase 8's wizard sets the real one. */
export const DEFAULT_LOCAL_ACTOR = 'me';

/** Default snooze: push `follow_up_at` 24h out when the request body omits an explicit time. */
const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * A placeholder runner used ONLY to satisfy `LearningDeps.runner` on the revert path (which never
 * calls the model — it restores a local tone snapshot + flips the server flag). It throws if ever run,
 * so a misuse surfaces loudly rather than silently making a model call.
 */
const REVERT_ONLY_RUNNER: ClaudeRunner = {
  run: () => Promise.reject(new Error('runner not configured (revert does not use the model)')),
};

export interface BackendApiDeps {
  /** The metadata-service client (its `pair()` backs the metadataService wiring check). */
  readonly metadata: MetadataClient;
  /** The disposable local cache (its open-ness backs the cache check + feeds thread/detail reads). */
  readonly cache: MessageCache;
  /** The local settings store (backs `GET`/`PUT /api/settings`; feeds stale thresholds + lock TTL). */
  readonly settingsStore: SettingsStore;
  /**
   * Push a WS message after a mutation so connected clients refetch (default: no-op). The runnable
   * entry wires this to the {@link createTodayWsServer} broadcaster; tests inject a spy.
   */
  readonly broadcast?: (msg: WsMessage) => void;
  /** Actor attributed to inline transitions / lock holder / send (default {@link DEFAULT_LOCAL_ACTOR}). */
  readonly actor?: string;
  /** Override the metadataService check (default: `checkMetadata(metadata)` → `metadata.pair()`). */
  readonly checkMetadata?: () => Promise<WiringStatus>;
  /** Override the claude check (default: `checkClaude()` → `CLAUDE_BIN` / `which claude`). */
  readonly checkClaude?: () => Promise<WiringStatus>;

  /* ---- Phase 7b (split work surface) — all OPTIONAL; an unconfigured endpoint returns 503 ---- */
  /** Claude runner — drafting/refine (Opus) + the pinned thread summary (Sonnet). */
  readonly runner?: ClaudeRunner;
  /** LOCAL-only draft persistence (body + refine transcript). Never synced to the server. */
  readonly draftStore?: DraftStore;
  /** Layered tone memory — appended onto `draft.md` (project → mailbox → contact). Optional. */
  readonly toneStore?: ToneStore;
  /** The local learning changelog (revert snapshots) — backs the D28 LIFO revert guard + learning. */
  readonly learningLog?: LearningLog;
  /** The send-path deps (real composer + STUB transport — D30). Required by `POST …/send`. */
  readonly sendDeps?: SendDeps;
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

/**
 * The LOCAL draft payload returned by the draft GET/generate/refine endpoints. Body + transcript are
 * machine-local (golden rule #3) — this is a localhost-only response, never a server DTO.
 */
export interface DraftResponse {
  readonly body: string;
  readonly model: string;
  readonly version: number;
  readonly transcript: { role: 'user' | 'assistant'; content: string }[];
}

/** The LOCAL rendered-body payload (parsed from the on-disk `.eml`; never crosses to the server). */
export interface MessageBodyResponse {
  readonly body: string;
}

/** The result of a manual send. */
export interface SendResponse {
  readonly messageId: string;
  /** The folder the Sent copy was filed into, or null (no IMAP creds yet → no append). */
  readonly filedTo: string | null;
  /** The task state after a successful send (auto-transition to waiting). */
  readonly state: 'waiting';
}

export function createBackendApi(deps: BackendApiDeps): Hono {
  const { cache, metadata, settingsStore, runner, draftStore, toneStore, learningLog, sendDeps } =
    deps;
  const broadcast = deps.broadcast ?? ((): void => {});
  const actor = deps.actor ?? DEFAULT_LOCAL_ACTOR;
  const metadataCheck = deps.checkMetadata ?? (() => checkMetadata(metadata));
  const claudeCheck = deps.checkClaude ?? (() => checkClaude());

  /** In-memory pinned-summary memo, keyed by thread; regenerated only when the message count changes. */
  const summaryMemo = new Map<string, { count: number; summary: string }>();

  const app = new Hono();

  app.onError((err, c) => {
    console.error('backend api error', err);
    return c.json({ error: 'internal server error' }, 500);
  });

  /* ----------------------------- wiring + reads ----------------------------- */

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

  /** The Today command center (concurrent metadata fetch; degrades to empty slices on failure). */
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

  app.get('/api/settings', (c) => c.json(settingsStore.read(), 200));

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

  /* --------------------------- inline task actions -------------------------- */

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

  /* =============================== Phase 7b ================================= */

  /**
   * Body-free thread detail (left pane). Maps the server thread (by `root_message_id`) to its cache
   * slice, attaches the current lock (presence) + a best-effort pinned summary (Sonnet, memoized).
   */
  app.get('/api/threads/:threadId', async (c) => {
    const threadId = c.req.param('threadId');
    const thread = await metadata.getThread(threadId).catch(() => null);
    const root = thread?.root_message_id ?? threadId;
    const rows = collectThreadRows(cache, root);
    if (thread === null && rows.length === 0) {
      return c.json({ error: 'thread not found', code: 'not_found' }, 404);
    }
    const locks = await metadata.listLocks().catch(() => [] as Lock[]);
    const lock = locks.find((l) => l.thread_id === threadId) ?? null;
    const pinnedSummary = await maybeSummary(threadId, rows, thread?.subject ?? undefined);
    const detail = buildThreadDetail({
      threadId,
      thread,
      rows,
      pinnedSummary,
      repoFreshness: null, // repo pointers wired in Phase 8 — structural placeholder
      lock,
    });
    return c.json(detail, 200);
  });

  /**
   * The rendered body of ONE message — LOCAL ONLY (golden rule #3). Parsed from the on-disk `.eml`;
   * never part of a shared/server DTO and never sent to the metadata server. 404 when uncached.
   */
  app.get('/api/threads/:threadId/messages/:messageId/body', async (c) => {
    // Hono already percent-decodes path params, so the raw Message-ID (e.g. `<id@host>`) arrives intact.
    const messageId = c.req.param('messageId');
    const row = findRowByMessageId(cache, messageId);
    if (row === undefined || row.eml_path === null) {
      return c.json({ error: 'message body not cached', code: 'not_found' }, 404);
    }
    try {
      const body = await renderMessageBody(row.eml_path);
      const payload: MessageBodyResponse = { body };
      return c.json(payload, 200);
    } catch {
      return c.json({ error: 'message body unreadable', code: 'not_found' }, 404);
    }
  });

  /** Generate the FIRST draft. Body persisted LOCALLY; only body-free DraftMeta is recorded on the server. */
  app.post('/api/threads/:threadId/draft', async (c) => {
    if (runner === undefined || draftStore === undefined) {
      return c.json({ error: 'drafting not configured', code: 'unavailable' }, 503);
    }
    const threadId = c.req.param('threadId');
    const raw = (await c.req.json().catch(() => undefined)) as
      | { instruction?: unknown }
      | undefined;
    const instruction = typeof raw?.instruction === 'string' ? raw.instruction : undefined;

    const { thread, context } = await loadDraftContext(threadId, instruction);
    const generation = await withDraftToneFile(
      toneStore,
      toneKeysFor(thread),
      (appendSystemPromptFile) =>
        generateDraft(runner, context, appendSystemPromptFile ? { appendSystemPromptFile } : {}),
    );

    const saved = draftStore.saveDraft(threadId, {
      body: generation.body,
      model: generation.model,
      author: AUTOMATED_ACTOR,
      transcript: generation.transcript,
    });
    // Record body-free DraftMeta on the server (best-effort — the local draft is the source of truth).
    await metadata
      .createDraftMeta({
        thread_id: threadId,
        version: saved.version,
        model: generation.model,
        author: AUTOMATED_ACTOR,
      })
      .catch((cause: unknown) => console.error('createDraftMeta failed', cause));
    broadcast({ type: 'today:changed' });
    return c.json(toDraftResponse(saved), 200);
  });

  /** Refine the current draft: REPLAY the transcript + new instruction into a fresh Opus call (rule #5). */
  app.post('/api/threads/:threadId/draft/refine', async (c) => {
    if (runner === undefined || draftStore === undefined) {
      return c.json({ error: 'drafting not configured', code: 'unavailable' }, 503);
    }
    const threadId = c.req.param('threadId');
    const raw = (await c.req.json().catch(() => undefined)) as
      | { instruction?: unknown }
      | undefined;
    const instruction = typeof raw?.instruction === 'string' ? raw.instruction.trim() : '';
    if (instruction === '') {
      return c.json({ error: 'instruction is required', code: 'invalid' }, 400);
    }
    const existing = draftStore.getDraft(threadId);
    if (existing === undefined) {
      return c.json({ error: 'no draft to refine', code: 'not_found' }, 404);
    }

    const { thread, context } = await loadDraftContext(threadId, undefined);
    const generation = await withDraftToneFile(
      toneStore,
      toneKeysFor(thread),
      (appendSystemPromptFile) =>
        refineDraft(
          runner,
          context,
          existing.transcript,
          instruction,
          appendSystemPromptFile ? { appendSystemPromptFile } : {},
        ),
    );

    const saved = draftStore.saveDraft(threadId, {
      body: generation.body,
      model: generation.model,
      author: existing.author,
      transcript: generation.transcript,
    });
    await metadata
      .createDraftMeta({
        thread_id: threadId,
        version: saved.version,
        model: generation.model,
        author: existing.author,
      })
      .catch((cause: unknown) => console.error('createDraftMeta failed', cause));
    broadcast({ type: 'today:changed' });
    return c.json(toDraftResponse(saved), 200);
  });

  /** The current local draft (body + transcript) for display. 404 when none exists. */
  app.get('/api/threads/:threadId/draft', (c) => {
    if (draftStore === undefined) {
      return c.json({ error: 'drafting not configured', code: 'unavailable' }, 503);
    }
    const draft = draftStore.getDraft(c.req.param('threadId'));
    if (draft === undefined) {
      return c.json({ error: 'no draft for thread', code: 'not_found' }, 404);
    }
    return c.json(toDraftResponse(draft), 200);
  });

  /**
   * MANUAL SEND (Golden rule #1) — fires ONLY on this explicit POST. Sends via `smtp/sendReply` with
   * the injected STUB transport (no live creds — D30), threads under the latest message, transitions
   * the task to `waiting`, fires the draft-vs-sent learning signal (best-effort), clears the local
   * draft, and broadcasts. The daemon has no path to this handler.
   */
  app.post('/api/threads/:threadId/send', async (c) => {
    if (sendDeps === undefined) {
      return c.json({ error: 'send not configured', code: 'unavailable' }, 503);
    }
    const threadId = c.req.param('threadId');
    const raw = (await c.req.json().catch(() => undefined)) as { body?: unknown } | undefined;
    const body = typeof raw?.body === 'string' ? raw.body : undefined;
    if (body === undefined || body.trim() === '') {
      return c.json({ error: 'body is required', code: 'invalid' }, 400);
    }
    const thread = await metadata.getThread(threadId).catch(() => null);
    if (thread === null) {
      return c.json({ error: 'thread not found', code: 'not_found' }, 404);
    }
    const rows = collectThreadRows(cache, thread.root_message_id);
    const parent = buildReplyParent(rows, thread.root_message_id);
    const message: OutgoingMessage = {
      from: thread.mailbox_address,
      to: [thread.sender],
      subject: replySubject(thread.subject),
      text: body,
    };
    const result = await sendReply(message, parent, sendDeps);

    // Auto-transition to waiting (I sent → waiting); best-effort metadata write, never a send.
    await transitionToWaiting(threadId).catch((cause: unknown) =>
      console.error('send: transition to waiting failed', cause),
    );

    // Draft-vs-sent learning signal (the Phase 6 trigger, finally wired) — best-effort, contact scope.
    await maybeLearnFromSend(threadId, thread, body).catch((cause: unknown) =>
      console.error('send: learning trigger failed', cause),
    );

    draftStore?.clearDraft(threadId);
    broadcast({ type: 'today:changed' });
    const payload: SendResponse = {
      messageId: result.messageId,
      filedTo: result.filedTo,
      state: 'waiting',
    };
    return c.json(payload, 200);
  });

  /* -------------------------------- locks ----------------------------------- */

  app.post('/api/threads/:threadId/lock/acquire', async (c) => {
    const threadId = c.req.param('threadId');
    const ttl = settingsStore.read().lockTimeoutMinutes * 60;
    const res = await metadata.acquireLock({
      thread_id: threadId,
      locked_by: actor,
      ttl_seconds: ttl,
    });
    broadcast({ type: 'today:changed' });
    return c.json(res, 200);
  });

  app.post('/api/threads/:threadId/lock/refresh', async (c) => {
    const threadId = c.req.param('threadId');
    const ttl = settingsStore.read().lockTimeoutMinutes * 60;
    try {
      const lock = await metadata.refreshLock({
        thread_id: threadId,
        locked_by: actor,
        ttl_seconds: ttl,
      });
      return c.json(lock, 200);
    } catch (err) {
      // A 409 means the lock is held by another actor (lost it) — surface it cleanly, not as a 500.
      if (err instanceof MetadataError && err.status >= 400 && err.status < 500) {
        return c.json({ error: err.message, code: err.code ?? 'lock' }, 409);
      }
      throw err;
    }
  });

  app.post('/api/threads/:threadId/lock/release', async (c) => {
    const threadId = c.req.param('threadId');
    const res = await metadata.releaseLock({ thread_id: threadId, locked_by: actor });
    broadcast({ type: 'today:changed' });
    return c.json(res, 200);
  });

  /* ------------------------- learning changelog ----------------------------- */

  app.get('/api/learning', async (c) => {
    const entries = await metadata.listLearningEntries().catch(emptyOnError('learning'));
    return c.json(entries, 200);
  });

  /**
   * Revert a learning entry — D28 LIFO guard ENFORCED SERVER-SIDE: refuse unless the target is the
   * LAST un-reverted entry for its tone-file `path` in the local {@link LearningLog} (reverting an
   * older lesson while a newer one is applied would silently drop the newer one).
   */
  app.post('/api/learning/:id/revert', async (c) => {
    if (learningLog === undefined || toneStore === undefined) {
      return c.json({ error: 'learning not configured', code: 'unavailable' }, 503);
    }
    const id = c.req.param('id');
    const entries = learningLog.list();
    const target = entries.find((e) => e.id === id);
    if (target === undefined) {
      return c.json({ error: 'no local snapshot for this learning entry', code: 'not_found' }, 404);
    }
    if (target.reverted_at !== null) {
      return c.json({ error: 'learning entry already reverted', code: 'conflict' }, 409);
    }
    const sameFileUnreverted = entries.filter(
      (e) => e.path === target.path && e.reverted_at === null,
    );
    const last = sameFileUnreverted[sameFileUnreverted.length - 1];
    if (last === undefined || last.id !== id) {
      return c.json(
        {
          error: 'LIFO: revert the most recently applied lesson for this file first',
          code: 'conflict',
        },
        409,
      );
    }
    const learningDeps: LearningDeps = {
      runner: runner ?? REVERT_ONLY_RUNNER,
      store: toneStore,
      log: learningLog,
      metadata,
    };
    const entry = await revertLearning(learningDeps, id, { now: new Date().toISOString() });
    broadcast({ type: 'today:changed' });
    return c.json(entry, 200);
  });

  /* ------------------------------- helpers ---------------------------------- */

  /** Load the thread + build a {@link DraftContext} (messages WITH bodies, read locally). */
  async function loadDraftContext(
    threadId: string,
    instruction: string | undefined,
  ): Promise<{ thread: Thread | null; context: DraftContext }> {
    const thread = await metadata.getThread(threadId).catch(() => null);
    const root = thread?.root_message_id ?? threadId;
    const rows = collectThreadRows(cache, root);
    const messages = await loadThreadMessageInputs(rows);
    const context: DraftContext = {
      subject: thread?.subject ?? '',
      messages,
      ...(thread?.sender ? { recipient: thread.sender } : {}),
      ...(instruction !== undefined ? { instructionText: instruction } : {}),
    };
    return { thread, context };
  }

  /** Best-effort pinned summary (Sonnet), memoized per (thread, message-count). Null without a runner. */
  async function maybeSummary(
    threadId: string,
    rows: readonly MessageRow[],
    subject: string | undefined,
  ): Promise<string | null> {
    if (runner === undefined || rows.length === 0) return null;
    const cached = summaryMemo.get(threadId);
    if (cached !== undefined && cached.count === rows.length) return cached.summary;
    try {
      const messages = await loadThreadMessageInputs(rows);
      const { summary } = await summarizeThread(
        runner,
        messages,
        subject !== undefined ? { subject } : {},
      );
      summaryMemo.set(threadId, { count: rows.length, summary });
      return summary;
    } catch (cause) {
      console.error('thread-detail summary failed', cause);
      return null;
    }
  }

  /** Transition the thread's active task to `waiting` after a manual send (metadata write, never a send). */
  async function transitionToWaiting(threadId: string): Promise<void> {
    const tasks = await metadata.listTasks(threadId);
    const target = tasks.find((t) => t.state !== 'done') ?? tasks[0];
    if (target !== undefined && target.state !== 'waiting') {
      await metadata.createTransition(target.id, { to: 'waiting', actor });
    }
  }

  /**
   * Fire the draft-vs-sent learning signal if the user edited Claude's draft before sending. Requires
   * the full learning stack (runner + tone store + learning log) and a clean contact email; otherwise a
   * silent no-op. The diff is computed LOCALLY and never leaves — only the LLM's one-line summary does.
   */
  async function maybeLearnFromSend(
    threadId: string,
    thread: Thread,
    sentBody: string,
  ): Promise<void> {
    if (runner === undefined || toneStore === undefined || learningLog === undefined) return;
    const existing = draftStore?.getDraft(threadId);
    if (existing === undefined) return;
    const diff = draftVsSentDiff(existing.body, sentBody);
    if (!diff.changed) return;
    const contactEmail = extractEmail(thread.sender);
    if (contactEmail === null) return; // avoid a malformed tone-file path
    const learningDeps: LearningDeps = { runner, store: toneStore, log: learningLog, metadata };
    await applyLearning(
      learningDeps,
      { projectId: metadata.getProjectId(), scope: 'contact', path: `contact/${contactEmail}.md` },
      { type: 'draft-vs-sent', diff },
      { now: new Date().toISOString() },
    );
  }

  return app;
}

/* ----------------------------- pure helpers -------------------------------- */

/** The tone-layer identifiers for a thread (project from the client; mailbox + contact from the thread). */
function toneKeysFor(thread: Thread | null): {
  projectId: string;
  mailboxAddress?: string | null;
  contactEmail?: string | null;
} {
  return {
    projectId: thread?.project_id ?? '',
    mailboxAddress: thread?.mailbox_address ?? null,
    contactEmail: extractEmail(thread?.sender ?? null),
  };
}

/** Build the reply parent from the latest cached message (for In-Reply-To/References), else the root. */
function buildReplyParent(
  rows: readonly MessageRow[],
  rootMessageId: string | null,
): ReplyParent | null {
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  if (last !== undefined && last.message_id !== null) {
    const references =
      last.references_json !== null ? (JSON.parse(last.references_json) as string[]) : [];
    return { messageId: last.message_id, references };
  }
  if (rootMessageId !== null && rootMessageId !== '') return { messageId: rootMessageId };
  return null;
}

/** Prefix a subject with `Re:` for a reply (idempotent — does not double-prefix). */
function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? '').trim();
  if (s === '') return 'Re:';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** Project a stored {@link LocalDraft}-shaped value onto the localhost {@link DraftResponse}. */
function toDraftResponse(draft: {
  body: string;
  model: string;
  version: number;
  transcript: { role: 'user' | 'assistant'; content: string }[];
}): DraftResponse {
  return {
    body: draft.body,
    model: draft.model,
    version: draft.version,
    transcript: draft.transcript,
  };
}

/**
 * Build a `.catch` handler for a metadata fetch: log the failure and substitute an empty slice, so one
 * down call degrades that slice rather than failing the whole endpoint.
 */
function emptyOnError(label: string): (cause: unknown) => never[] {
  return (cause: unknown): never[] => {
    console.error(`/api: ${label} fetch failed`, cause);
    return [];
  };
}
