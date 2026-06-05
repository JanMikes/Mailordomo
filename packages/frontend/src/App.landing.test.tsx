/**
 * LIGHT smoke (Implementer) — the D32 `defaultView` LANDING behaviour: on load the app opens the view
 * persisted in AppSettings (the real "never trapped"). The exhaustive nav suite is the separate
 * test-author's; here we only prove the app lands on Today by default and on the 3-pane when
 * `defaultView === 'three-pane'`, seeding the initial view from the settings query (no hard-default
 * snap). Bodies stay local; this asserts only routing.
 */
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppSettings, DefaultView, ProjectsBoard } from '@mailordomo/shared';

import { mockFetch } from '@/test/fetch-mock';

// Stub the live-update socket (Today + the board both subscribe; no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

// The full shell renders ThemeToggle → useColorScheme, which reads `matchMedia` (absent in jsdom).
beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
});

import { App } from './App';

function settings(defaultView: DefaultView): AppSettings {
  return {
    waitingStaleDays: 3,
    needsReplyStaleDays: 2,
    lockTimeoutMinutes: 30,
    colorScheme: 'system',
    defaultView,
  };
}

const EMPTY_BOARD: ProjectsBoard = { generatedAt: '2026-06-06T09:00:00.000Z', projects: [] };

function renderApp(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('App landing view (D32 defaultView)', () => {
  it('lands on Today when defaultView is "today"', async () => {
    mockFetch([
      { url: '/api/settings', json: settings('today') },
      { url: '/api/today', json: { promiseMetrics: null }, status: 503 },
    ]);
    renderApp(<App />);
    // The Today header copy is unique to the Today command center.
    expect(await screen.findByText('What needs you, ranked by what you owe.')).toBeInTheDocument();
  });

  it('lands on the 3-pane when defaultView is "three-pane"', async () => {
    mockFetch([
      { url: '/api/settings', json: settings('three-pane') },
      { url: '/api/projects-board', json: EMPTY_BOARD },
    ]);
    renderApp(<App />);
    // The reading-pane empty state is unique to the 3-pane fallback (vs. the sidebar nav item).
    expect(await screen.findByText('Select a thread to read it here.')).toBeInTheDocument();
  });
});
