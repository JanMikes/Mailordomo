/**
 * Mailordomo frontend root. The app shell hosts the views; with no router (D31), `App` lifts the
 * tiny navigation state — which thread (if any) is open + the selected top-level view — and shares it
 * through `NavContext`. A selected thread renders the split work surface (7b); otherwise the Today
 * command center (7a) or the Memory changelog. The 3-pane fallback + project views land in 7c.
 */
import { useMemo, useState } from 'react';

import { AppShell } from './components/app-shell';
import { TodayPage } from './components/today/today-page';
import { MemoryPage } from './components/memory/memory-page';
import { WorkSurface } from './components/work-surface/work-surface';
import { NavContext, type AppView, type NavController } from './lib/navigation';

export function App() {
  const [view, setView] = useState<AppView>('today');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftOnOpen, setDraftOnOpen] = useState(false);

  const nav: NavController = useMemo(
    () => ({
      view,
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
        ) : view === 'memory' ? (
          <MemoryPage />
        ) : (
          <TodayPage />
        )}
      </AppShell>
    </NavContext.Provider>
  );
}
