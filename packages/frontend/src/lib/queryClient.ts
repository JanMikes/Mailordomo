import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client (the ONLY client-side state of record — there is no localStorage
 * source of truth; theme + settings live in the backend config, fetched like any other query).
 *
 * `staleTime: 30s` keeps the Today view from refetching on every focus/mount churn; freshness comes
 * from the WS `today:changed` push (see `useWs`) which invalidates `['today']` the instant the
 * backend's data changes, so the polling interval can stay off.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
