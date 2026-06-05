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
import type { AppSettings, Task, TodayReadModel, UpdateSettingsRequest } from '@mailordomo/shared';
import { AppSettingsSchema, TaskSchema, TodayReadModelSchema } from '@mailordomo/shared';

/** Stable React Query keys (centralized so invalidation can never typo a key). */
export const queryKeys = {
  today: ['today'] as const,
  settings: ['settings'] as const,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Fetch `/api{path}`, throwing a readable error (preferring the backend's `{error}` message). */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        detail = String((body as { error: unknown }).error);
      }
    } catch {
      // non-JSON error body — keep the status-code detail
    }
    throw new Error(`${path} — ${detail}`);
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
