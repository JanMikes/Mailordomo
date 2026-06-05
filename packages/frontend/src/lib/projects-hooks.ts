/**
 * React Query hooks for the Phase 7c views (PLAN.md §7 / D32): the all-projects board and the classic
 * 3-pane fallback. Keeping the cache keys here (not in components) keeps invalidation consistent — both
 * views read the same body-free `projects-board` model, so they share one cache entry.
 *
 * GOLDEN RULE #3: the board is body-free (subject/snippet/sender + state metadata only). The 3-pane
 * reading pane reuses the 7b `useThreadDetail` + the lazy per-message LOCAL `…/body` hop (see
 * `work-surface-hooks`); no body is fetched or cached here.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchProject, fetchProjectsBoard, queryKeys } from './api';

/** The all-projects board: each project's threads grouped by task state (shared by both 7c views). */
export function useProjectsBoard() {
  return useQuery({ queryKey: queryKeys.projectsBoard, queryFn: fetchProjectsBoard });
}

/** The configured project's identity (`{ id, name }`); `name` is null when the server is unreachable. */
export function useProject() {
  return useQuery({ queryKey: queryKeys.project, queryFn: fetchProject });
}
