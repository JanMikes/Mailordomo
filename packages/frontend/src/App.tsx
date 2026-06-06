/**
 * Mailordomo frontend root. The app shell hosts the views; with no router (D31/D32), `App` lifts the
 * tiny navigation state — which thread (if any) is open + the selected top-level view — and shares it
 * through `NavContext`. A selected thread renders the split work surface (7b); otherwise one of the
 * top-level views: the Today command center (7a), the Memory changelog, the all-projects board, or the
 * classic 3-pane fallback (7c).
 *
 * The INITIAL view is the persisted `AppSettings.defaultView` (D32 — the real "never trapped"): `view`
 * stays `null` until settings resolve, then it is seeded ONCE from `defaultView` (so a user who chose
 * the 3-pane lands there with no Today→3-pane flicker). After that the user's nav fully owns it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppShell } from './components/app-shell';
import { TodayPage } from './components/today/today-page';
import { DigestPage } from './components/digest/digest-page';
import { MemoryPage } from './components/memory/memory-page';
import { ProjectsBoardPage } from './components/projects/projects-board-page';
import { ThreePanePage } from './components/three-pane/three-pane-page';
import { SetupPage } from './components/setup/setup-page';
import { WorkSurface } from './components/work-surface/work-surface';
import { Skeleton } from './components/ui/skeleton';
import { useSettingsQuery } from './lib/today-hooks';
import { NavContext, type AppView, type NavController } from './lib/navigation';

export function App() {
  const settings = useSettingsQuery();
  // `null` = the landing view hasn't been resolved from settings yet (avoids a default→stored snap).
  const [view, setView] = useState<AppView | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftOnOpen, setDraftOnOpen] = useState(false);
  const seededLanding = useRef(false);

  // Seed the initial view from the persisted default exactly once, when settings first arrive.
  useEffect(() => {
    if (seededLanding.current || !settings.data) return;
    seededLanding.current = true;
    setView(settings.data.defaultView === 'three-pane' ? 'three-pane' : 'today');
  }, [settings.data]);

  const nav: NavController = useMemo(
    () => ({
      // Until the landing view resolves, report `today` to consumers (the nav controller's contract is
      // non-null); the main area shows a loading placeholder, so this is never actually rendered.
      view: view ?? 'today',
      selectedThreadId,
      draftOnOpen,
      openThread: (threadId, opts) => {
        setSelectedThreadId(threadId);
        setDraftOnOpen(opts?.draft ?? false);
      },
      closeThread: () => {
        setSelectedThreadId(null);
        setDraftOnOpen(false);
      },
      goTo: (next) => {
        seededLanding.current = true; // an explicit switch wins over the (possibly late) seed
        setSelectedThreadId(null);
        setDraftOnOpen(false);
        setView(next);
      },
    }),
    [view, selectedThreadId, draftOnOpen],
  );

  return (
    <NavContext.Provider value={nav}>
      <AppShell>
        {selectedThreadId !== null ? (
          <WorkSurface
            key={selectedThreadId}
            threadId={selectedThreadId}
            autoDraft={draftOnOpen}
            onClose={nav.closeThread}
          />
        ) : (
          <MainView view={view} />
        )}
      </AppShell>
    </NavContext.Provider>
  );
}

/** Render the selected top-level view, or a quiet placeholder while the landing view resolves. */
function MainView({ view }: { view: AppView | null }) {
  if (view === null) return <LandingPlaceholder />;
  if (view === 'digest') return <DigestPage />;
  if (view === 'memory') return <MemoryPage />;
  if (view === 'all-projects') return <ProjectsBoardPage />;
  if (view === 'three-pane') return <ThreePanePage />;
  if (view === 'setup') return <SetupPage />;
  return <TodayPage />;
}

/** A minimal full-height skeleton shown only for the brief moment before settings resolve. */
function LandingPlaceholder() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8" aria-hidden>
      <Skeleton className="h-8 w-40" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
    </div>
  );
}
