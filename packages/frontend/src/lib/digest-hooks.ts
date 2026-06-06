/**
 * React Query hook for the morning digest (PROJECT.md §9 / D34). Like the Today hooks, the query
 * wiring lives here (not in the component) so the cache key stays in one place.
 *
 * The digest is a once-a-morning read, not a live queue, so it just fetches on mount and rides the
 * default `staleTime`; there is no mutation and no WS invalidation to wire (it is read-only — the
 * thread rows escalate to the existing 7b work surface for any action).
 */
import { useQuery } from '@tanstack/react-query';
import { fetchDigest, queryKeys } from './api';

export function useDigest() {
  return useQuery({ queryKey: queryKeys.digest, queryFn: fetchDigest });
}
