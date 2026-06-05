/**
 * The typed REST client for the localhost backend (PLAN.md §7 Phase 7a / D29). Components NEVER call
 * `fetch` directly — they go through these functions (or the `today-hooks` wrappers), so request
 * shapes, the `/api` prefix, and response validation live in exactly one place.
 *
 * Responses are validated against the `@mailordomo/shared` zod schemas: the Today/Settings models are
 * strict + body-free by construction, so a parse here is both a type guarantee AND a privacy/contract
 * check — drift or a smuggled field surfaces as a loud error instead of silently rendering.
 *
 * GOLDEN RULE #1: there is deliberately no send/draft call here. The only task mutations are the
 * metadata writes the 7a backend exposes — `markDone` (a state transition) and `snooze` (a
 * `follow_up_at` edit). Drafting/sending arrives in 7b behind an explicit user action.
 */
import type {
  AcquireLockResponse,
  AppSettings,
  LearningEntry,
  Lock,
  ReleaseLockResponse,
  Task,
  ThreadDetail,
  TodayReadModel,
  UpdateSettingsRequest,
} from '@mailordomo/shared';
import {
  AcquireLockResponseSchema,
  AppSettingsSchema,
  LearningEntryListResponseSchema,
  LearningEntrySchema,
  LockSchema,
  ReleaseLockResponseSchema,
  TaskSchema,
  ThreadDetailSchema,
  TodayReadModelSchema,
} from '@mailordomo/shared';

/** Stable React Query keys (centralized so invalidation can never typo a key). */
export const queryKeys = {
  today: ['today'] as const,
  settings: ['settings'] as const,
  learning: ['learning'] as const,
  threadDetail: (threadId: string) => ['thread', threadId, 'detail'] as const,
  messageBody: (threadId: string, messageId: string) =>
    ['thread', threadId, 'body', messageId] as const,
  draft: (threadId: string) => ['thread', threadId, 'draft'] as const,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * A failed `/api` request. Carries the HTTP `status` and the backend's `code` (e.g. `not_found`,
 * `unavailable`, `conflict`) so callers can branch on them — a 404 draft means "none yet", a 409
 * refresh means "lost the lock", a 503 means "feature unconfigured" — instead of string-matching.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fetch `/api{path}`, throwing an {@link ApiError} (preferring the backend's `{error}`/`{code}`). */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') {
        if ('error' in body) detail = String((body as { error: unknown }).error);
        if ('code' in body) code = String((body as { code: unknown }).code);
      }
    } catch {
      // non-JSON error body — keep the status-code detail
    }
    throw new ApiError(`${path} — ${detail}`, res.status, code);
  }
  return res.json();
}

/** GET the assembled Today read model (metrics + counts + ranked do-next cards). */
export async function fetchToday(): Promise<TodayReadModel> {
  return TodayReadModelSchema.parse(await request('/today'));
}

/** GET the local app settings (stale thresholds, lock timeout, color scheme). */
export async function fetchSettings(): Promise<AppSettings> {
  return AppSettingsSchema.parse(await request('/settings'));
}

/** PUT a partial settings patch; returns the full updated settings. */
export async function updateSettings(patch: UpdateSettingsRequest): Promise<AppSettings> {
  return AppSettingsSchema.parse(
    await request('/settings', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),
  );
}

/** The shape of `POST /api/tasks/:id/done` (a backend-local response, not a shared DTO). */
export interface MarkDoneResult {
  readonly threadId: string;
  readonly state: 'done';
  readonly changed: boolean;
}

/** Mark a thread's task done — a metadata state transition (NOT a send). */
export async function markDone(threadId: string): Promise<MarkDoneResult> {
  const body = await request(`/tasks/${encodeURIComponent(threadId)}/done`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  });
  return body as MarkDoneResult;
}

/** Snooze a thread's task — set its `follow_up_at` (defaults to 24h out server-side when omitted). */
export async function snooze(threadId: string, followUpAt?: string): Promise<Task> {
  const body = followUpAt === undefined ? '{}' : JSON.stringify({ follow_up_at: followUpAt });
  return TaskSchema.parse(
    await request(`/tasks/${encodeURIComponent(threadId)}/snooze`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    }),
  );
}

/* ============================ Phase 7b — work surface ============================ */
/*
 * GOLDEN RULE #3: every call below is to the LOCAL 127.0.0.1 backend (the `/api` proxy). Draft
 * bodies, refine transcripts, and rendered message bodies are LOCAL-only hops — this client never
 * posts a body to anything else, and nothing here is persisted in localStorage.
 */

/** One turn in the refine chat (a backend-local shape, not a server DTO). */
export interface RefineTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** The LOCAL draft payload (body + transcript live only on this machine — golden rule #3). */
export interface DraftResponse {
  readonly body: string;
  readonly model: string;
  readonly version: number;
  readonly transcript: RefineTurn[];
}

/** The result of a manual send (golden rule #1 — only ever fired by an explicit user click). */
export interface SendResult {
  readonly messageId: string;
  readonly filedTo: string | null;
  readonly state: 'waiting';
}

/** GET the body-free thread detail for the left pane (validated against the strict shared schema). */
export async function fetchThreadDetail(threadId: string): Promise<ThreadDetail> {
  return ThreadDetailSchema.parse(await request(`/threads/${encodeURIComponent(threadId)}`));
}

/** GET one message's rendered body — a LOCAL-only hop (parsed from the on-disk `.eml`). */
export async function fetchMessageBody(threadId: string, messageId: string): Promise<string> {
  const body = (await request(
    `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/body`,
  )) as { body: string };
  return body.body;
}

/** GET the current local draft; `null` when none exists yet (404 is an expected, non-error state). */
export async function fetchDraft(threadId: string): Promise<DraftResponse | null> {
  try {
    return (await request(`/threads/${encodeURIComponent(threadId)}/draft`)) as DraftResponse;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** POST to generate the FIRST draft (optional instruction text folded into the Opus prompt). */
export async function generateDraft(
  threadId: string,
  instruction?: string,
): Promise<DraftResponse> {
  const body = instruction ? JSON.stringify({ instruction }) : '{}';
  return (await request(`/threads/${encodeURIComponent(threadId)}/draft`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body,
  })) as DraftResponse;
}

/** POST a refine instruction — the backend replays the transcript into a fresh Opus call (rule #5). */
export async function refineDraft(threadId: string, instruction: string): Promise<DraftResponse> {
  return (await request(`/threads/${encodeURIComponent(threadId)}/draft/refine`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ instruction }),
  })) as DraftResponse;
}

/** The MANUAL send (golden rule #1). `body` is the (possibly user-edited) draft text being sent. */
export async function sendDraft(threadId: string, body: string): Promise<SendResult> {
  return (await request(`/threads/${encodeURIComponent(threadId)}/send`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ body }),
  })) as SendResult;
}

/** Acquire the thread lock on open (no ttl — the backend derives it from `lockTimeoutMinutes`). */
export async function acquireLock(threadId: string): Promise<AcquireLockResponse> {
  return AcquireLockResponseSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/acquire`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** Heartbeat-refresh the held lock; throws an {@link ApiError} 409 if it was lost to another holder. */
export async function refreshLock(threadId: string): Promise<Lock> {
  return LockSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/refresh`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** Release the thread lock on close/unmount. */
export async function releaseLock(threadId: string): Promise<ReleaseLockResponse> {
  return ReleaseLockResponseSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/release`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** GET the learning changelog (always a 200 list; the backend degrades to `[]` on a down call). */
export async function fetchLearning(): Promise<LearningEntry[]> {
  return LearningEntryListResponseSchema.parse(await request('/learning'));
}

/**
 * Revert one learning entry. Throws an {@link ApiError} 409 when the LIFO guard refuses (the target
 * is not the last un-reverted entry for its tone-file, or is already reverted) — surfaced as a calm
 * "revert the most recent change first" message, NOT an alarming failure.
 */
export async function revertLearning(id: string): Promise<LearningEntry> {
  return LearningEntrySchema.parse(
    await request(`/learning/${encodeURIComponent(id)}/revert`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}
