/**
 * Mailordomo frontend root (Phase 7a). The app shell hosts the Today command center; the split work
 * surface (7b) and the 3-pane fallback + project views (7c) plug into the same shell next.
 */
import { AppShell } from './components/app-shell';
import { TodayPage } from './components/today/today-page';

export function App() {
  return (
    <AppShell>
      <TodayPage />
    </AppShell>
  );
}
