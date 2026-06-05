/**
 * React Query hooks for the Today view + settings. Keeping the query/mutation wiring here (not in
 * components) means a component just calls `useTodayQuery()` / `useMarkDone()` and the cache keys +
 * invalidation rules stay consistent in one spot.
 *
 * After any mutation we invalidate `['today']`; the backend ALSO broadcasts `today:changed` over the
 * WS, so the view refetches both on the optimistic local invalidation and on the server signal
 * (React Query dedupes the in-flight request).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateSettingsRequest } from '@mailordomo/shared';
import { fetchSettings, fetchToday, markDone, queryKeys, snooze, updateSettings } from './api';

export function useTodayQuery() {
  return useQuery({ queryKey: queryKeys.today, queryFn: fetchToday });
}

export function useSettingsQuery() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: fetchSettings });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSettingsRequest) => updateSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.settings, data);
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
}

export function useMarkDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => markDone(threadId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
}

export function useSnooze() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { threadId: string; followUpAt?: string }) =>
      snooze(vars.threadId, vars.followUpAt),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    },
  });
}
