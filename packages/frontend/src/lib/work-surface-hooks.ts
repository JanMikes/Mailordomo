/**
 * React Query hooks + the thread-lock lifecycle for the split work surface (PLAN.md §7 Phase 7b /
 * D31). Keeping the cache keys, invalidation, and the lock heartbeat here (not in components) means a
 * component just calls `useThreadDetail()` / `useDraft()` / `useThreadLock()` and the wiring stays in
 * one place.
 *
 * GOLDEN RULES honored here: #1 — there is NO effect/timer that posts to `…/send`; sending is only
 * ever the explicit `useSendDraft().mutate(...)` from a user click. #3 — draft/refine/body data comes
 * from the local backend and is held only in the React Query cache (never localStorage).
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Lock } from '@mailordomo/shared';

import {
  ApiError,
  acquireLock,
  fetchDraft,
  fetchLearning,
  fetchMessageBody,
  fetchThreadDetail,
  generateDraft,
  queryKeys,
  refineDraft,
  refreshLock,
  releaseLock,
  revertLearning,
  sendDraft,
} from './api';
import { useSettingsQuery } from './today-hooks';

/* -------------------------------- thread detail -------------------------------- */

/** The body-free left-pane read model for one open thread. */
export function useThreadDetail(threadId: string) {
  return useQuery({
    queryKey: queryKeys.threadDetail(threadId),
    queryFn: () => fetchThreadDetail(threadId),
  });
}

/**
 * One message's rendered body — fetched LAZILY (only when `enabled`, i.e. the message is expanded).
 * A cached `.eml` body is immutable, so it never goes stale.
 */
export function useMessageBody(threadId: string, messageId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.messageBody(threadId, messageId),
    queryFn: () => fetchMessageBody(threadId, messageId),
    enabled,
    staleTime: Infinity,
  });
}

/* ------------------------------------ draft ------------------------------------ */

/**
 * The current local draft, or `null` when none exists yet (404). A 503 ("drafting not configured")
 * surfaces as `isError` with an {@link ApiError} the pane reads to show a graceful state. `staleTime:
 * 0` — a draft is always re-validated on mount (D31).
 */
export function useDraft(threadId: string) {
  return useQuery({
    queryKey: queryKeys.draft(threadId),
    queryFn: () => fetchDraft(threadId),
    staleTime: 0,
    retry: false,
  });
}

/** Generate the FIRST draft (optional instruction). Seeds the draft cache + refreshes Today. */
export function useGenerateDraft(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instruction?: string) => generateDraft(threadId, instruction),
    onSuccess: (draft) => {
      qc.setQueryData(queryKeys.draft(threadId), draft);
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
}

/** Refine the draft — backend replays the transcript into a fresh Opus call (golden rule #5). */
export function useRefineDraft(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (instruction: string) => refineDraft(threadId, instruction),
    onSuccess: (draft) => {
      qc.setQueryData(queryKeys.draft(threadId), draft);
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
}

/**
 * The MANUAL send (golden rule #1) — only ever invoked by an explicit Send click. On success the
 * server-side draft is cleared and the task moves to `waiting`, so we drop the local draft cache and
 * refresh Today + the thread detail.
 */
export function useSendDraft(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => sendDraft(threadId, body),
    onSuccess: () => {
      qc.setQueryData(queryKeys.draft(threadId), null);
      void qc.invalidateQueries({ queryKey: queryKeys.today });
      void qc.invalidateQueries({ queryKey: queryKeys.threadDetail(threadId) });
    },
  });
}

/* ------------------------------------ locks ------------------------------------ */

const DEFAULT_LOCK_TIMEOUT_MINUTES = 30;
/** Never beat faster than every 30s, however small the timeout (avoids hammering the server). */
const MIN_HEARTBEAT_MS = 30_000;

/**
 * Thread presence (PROJECT.md §6 / D27). `held` ⇒ this user owns the lock and may edit/send;
 * `contended` ⇒ another actor holds it (read-only — show the holder, disable Send); `lost` ⇒ a
 * heartbeat 409'd and we couldn't re-grab it; `error` ⇒ the acquire failed.
 */
export type LockPresence =
  | { readonly kind: 'acquiring' }
  | { readonly kind: 'held'; readonly lock: Lock }
  | { readonly kind: 'contended'; readonly lock: Lock }
  | { readonly kind: 'lost' }
  | { readonly kind: 'error'; readonly message: string };

/** True only while THIS user holds the lock — the gate for editing + the Send button. */
export function holdsLock(presence: LockPresence): boolean {
  return presence.kind === 'held';
}

/**
 * Acquire the thread lock on mount, heartbeat-refresh it at ~`lockTimeoutMinutes`/2 (floored at 30s)
 * while held, and release it on unmount. A refresh 409 (another actor took it) stops the heartbeat and
 * re-acquires to learn the new holder so the presence banner stays accurate. No `ttl` is sent — the
 * backend derives it from settings; we only need the cadence here.
 */
export function useThreadLock(threadId: string): LockPresence {
  const settings = useSettingsQuery();
  const lockTimeoutMinutes = settings.data?.lockTimeoutMinutes ?? DEFAULT_LOCK_TIMEOUT_MINUTES;
  const heartbeatMs = useMemo(
    () => Math.max(MIN_HEARTBEAT_MS, Math.floor((lockTimeoutMinutes * 60) / 2) * 1000),
    [lockTimeoutMinutes],
  );
  const [presence, setPresence] = useState<LockPresence>({ kind: 'acquiring' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let holding = false;

    function stopHeartbeat(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    }

    async function grab(): Promise<void> {
      try {
        const res = await acquireLock(threadId);
        if (cancelled) {
          // Acquired then unmounted mid-flight → release so we don't leave a stale lock.
          if (res.acquired) void releaseLock(threadId).catch(() => {});
          return;
        }
        if (res.acquired) {
          holding = true;
          setPresence({ kind: 'held', lock: res.lock });
          stopHeartbeat();
          timer = setInterval(() => void heartbeat(), heartbeatMs);
        } else {
          holding = false;
          stopHeartbeat();
          setPresence({ kind: 'contended', lock: res.lock });
        }
      } catch (err) {
        if (cancelled) return;
        holding = false;
        stopHeartbeat();
        setPresence({
          kind: 'error',
          message: err instanceof Error ? err.message : 'could not acquire the thread lock',
        });
      }
    }

    async function heartbeat(): Promise<void> {
      try {
        const lock = await refreshLock(threadId);
        if (!cancelled) setPresence({ kind: 'held', lock });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 409) {
          // Lost the lock to another actor — stop beating, surface it, and re-acquire to learn who holds it.
          holding = false;
          stopHeartbeat();
          setPresence({ kind: 'lost' });
          void grab();
        }
        // Other transient errors: leave the heartbeat running; the next tick retries.
      }
    }

    void grab();

    return () => {
      cancelled = true;
      stopHeartbeat();
      if (holding) void releaseLock(threadId).catch(() => {});
    };
  }, [threadId, heartbeatMs]);

  return presence;
}

/* ---------------------------------- learning ----------------------------------- */

/** GET the silent-learning changelog (PROJECT.md §6 — review + revert). */
export function useLearningEntries() {
  return useQuery({ queryKey: queryKeys.learning, queryFn: fetchLearning });
}

/**
 * Revert a learning entry. The backend enforces the D28 LIFO guard; a 409 here means "not the last
 * un-reverted change for its file" (or already reverted) — the caller turns it into a calm message.
 */
export function useRevertLearning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revertLearning(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.learning });
    },
  });
}
