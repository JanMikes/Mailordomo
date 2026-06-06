/**
 * The app-level view switch (PLAN.md §7 Phase 7b / D31; extended in 7c / D32). There is deliberately
 * NO router yet — the surface stays small enough that `App` lifts a tiny bit of navigation state
 * (which thread, if any, is open + which top-level view is selected) and shares it through this
 * context, so the do-next card / board card can open the work surface and the sidebar can switch
 * views without prop-drilling or any global mutable singleton.
 *
 * The context has a safe no-op DEFAULT so a component rendered outside the provider (e.g. an isolated
 * unit test of a do-next card) never throws — it simply gets inert navigation.
 */
import { createContext, useContext } from 'react';

/**
 * The top-level views reachable from the sidebar (the thread work surface is opened separately):
 * the opinionated `today` command center, the `memory` changelog, the all-projects board
 * (`all-projects`), the classic `three-pane` fallback — the "never trapped" escape hatch (D32) — and
 * the `setup` wizard (project → mailbox → repo → Claude health) plus raw-config view (Phase 8 / D33).
 */
export type AppView = 'today' | 'memory' | 'all-projects' | 'three-pane' | 'setup';

export interface NavController {
  /** The currently selected top-level view (ignored while a thread work surface is open). */
  readonly view: AppView;
  /** The open thread's id, or `null` when no work surface is showing. */
  readonly selectedThreadId: string | null;
  /** When a thread is open, whether to kick off a draft immediately (the do-next "Draft" action). */
  readonly draftOnOpen: boolean;
  /** Open the split work surface for a thread; `draft:true` also starts a draft (do-next Draft button). */
  readonly openThread: (threadId: string, opts?: { draft?: boolean }) => void;
  /** Close the work surface and return to the last top-level view (Today). */
  readonly closeThread: () => void;
  /** Switch the top-level view (also closes any open work surface). */
  readonly goTo: (view: AppView) => void;
}

const NOOP_NAV: NavController = {
  view: 'today',
  selectedThreadId: null,
  draftOnOpen: false,
  openThread: () => {},
  closeThread: () => {},
  goTo: () => {},
};

export const NavContext = createContext<NavController>(NOOP_NAV);

/** Read the navigation controller (safe outside a provider — returns an inert default). */
export function useNav(): NavController {
  return useContext(NavContext);
}
