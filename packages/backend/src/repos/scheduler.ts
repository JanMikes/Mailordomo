/**
 * The PURE repo-pull scheduler (PLAN.md §7 Phase 8, D33). Decides WHICH read-only mirrors are due for
 * a `git fetch`, given each repo's auto-pull flag + last-pull time, the interval, and an INJECTED
 * `now`. No IO, no clock, no spawn — the actual `git fetch` is the {@link GitRunner} seam; this just
 * decides the set. That split is what makes scheduling unit-testable without touching `git`.
 */

/** The per-repo state the scheduler reasons over. */
export interface RepoPullState {
  /** The shared repo identity id (links to a `RepoPointer` + `LocalRepoConfig`). */
  readonly repoPointerId: string;
  /** Whether the "actively pull" checkbox is on (PROJECT.md §10). Off ⇒ never due. */
  readonly activePull: boolean;
  /** ISO-8601 instant of the last successful fetch, or `null` if never pulled (⇒ due immediately). */
  readonly lastPulledAt: string | null;
}

export interface PullSchedulerInput {
  readonly repos: readonly RepoPullState[];
  /** Minimum gap between fetches for one repo, in milliseconds. */
  readonly intervalMs: number;
  /** "Now" as epoch milliseconds — INJECTED for determinism. */
  readonly now: number;
}

/**
 * The repos due for a fetch right now: `activePull` on AND (never pulled OR `now - lastPulled >=
 * interval`). A repo with auto-pull off is never returned; a malformed `lastPulledAt` is treated as
 * "never pulled" (due) so a corrupt timestamp can't wedge a repo permanently stale. Pure + total.
 */
export function reposDueForPull(input: PullSchedulerInput): RepoPullState[] {
  const { repos, intervalMs, now } = input;
  return repos.filter((repo) => {
    if (!repo.activePull) return false;
    if (repo.lastPulledAt === null) return true;
    const last = Date.parse(repo.lastPulledAt);
    if (Number.isNaN(last)) return true; // unparseable ⇒ treat as never pulled
    return now - last >= intervalMs;
  });
}

/** Default mirror-refresh interval: 15 minutes (matches the conservative poll cadence in §4/D22). */
export const DEFAULT_REPO_PULL_INTERVAL_MS = 15 * 60 * 1000;
