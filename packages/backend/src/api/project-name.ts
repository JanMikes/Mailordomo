/**
 * The cached project-name resolver (PLAN.md §7 Phase 7c, decision D32) — closes the 7a→7c deferral
 * where cards showed the raw `projectId`. The metadata client is project-scoped (a single configured
 * `METADATA_PROJECT_ID`), and a project's display NAME comes from `pair()` → {@link AuthedProject}.
 *
 * Caching + degradation contract (the reviewer's checklist):
 *  - It calls `metadata.pair()` AT MOST ONCE for a successful resolution, then MEMOIZES the
 *    `AuthedProject`. The project name rarely changes; a process restart re-resolves it.
 *  - BEST-EFFORT: if `pair()` throws (metadata service down/unpaired), the name resolves to `null`.
 *    It NEVER throws and NEVER blocks a read — a board/today/detail response renders with a null
 *    `projectName`, exactly like the other body-free fields degrade. A later call retries (the
 *    failure is not memoized), so the name appears once the service is reachable.
 *
 * This is a tiny read-only helper over the metadata client — no new writable store, no two-way sync
 * (Golden rule #2).
 */
import type { AuthedProject } from '@mailordomo/shared';

/** The subset of the metadata client this resolver needs (so it is trivial to fake in a test). */
export interface ProjectPairer {
  getProjectId(): string;
  pair(): Promise<AuthedProject>;
}

/** Resolve (and cache) the configured project's identity, degrading to a null name on failure. */
export interface ProjectNameResolver {
  /** The configured project id (always known — it is local config, not a network read). */
  projectId(): string;
  /**
   * The resolved project NAME, or `null` if it could not be resolved yet (metadata unreachable). The
   * first successful resolution is cached; a failed attempt is not, so a later call retries.
   */
  resolveName(): Promise<string | null>;
}

/**
 * Build a {@link ProjectNameResolver} over a metadata client. The successful {@link AuthedProject} is
 * held in a closure cache; concurrent callers before the first resolution share the in-flight promise
 * so `pair()` is not hit more than necessary.
 */
export function createProjectNameResolver(pairer: ProjectPairer): ProjectNameResolver {
  let cached: AuthedProject | undefined;
  let inFlight: Promise<AuthedProject | undefined> | undefined;

  async function resolve(): Promise<AuthedProject | undefined> {
    if (cached !== undefined) return cached;
    // Coalesce concurrent first-resolution callers onto one `pair()` round-trip.
    if (inFlight === undefined) {
      inFlight = pairer
        .pair()
        .then((project) => {
          cached = project;
          return project;
        })
        .catch((cause: unknown) => {
          // Best-effort: log + return undefined (→ null name). Do NOT memoize the failure — retry next call.
          console.error('project-name: pair() failed; project name unresolved', cause);
          return undefined;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }
    return inFlight;
  }

  return {
    projectId: () => pairer.getProjectId(),
    resolveName: async () => (await resolve())?.name ?? null,
  };
}
