/**
 * Theme controller (PROJECT.md §11 light/dark; D29 — `colorScheme` persists in the backend settings,
 * NOT localStorage). Source of truth is `AppSettings.colorScheme` from `GET /api/settings`; the
 * toggle writes it back via `PUT /api/settings`. `system` follows the OS via `matchMedia`. The
 * resolved scheme is applied by toggling the `.dark` class on <html>.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ColorScheme } from '@mailordomo/shared';
import { useSettingsQuery, useUpdateSettings } from './today-hooks';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MEDIA_QUERY).matches;
}

export interface ColorSchemeController {
  /** The stored preference (`light` | `dark` | `system`); defaults to `system` until settings load. */
  scheme: ColorScheme;
  /** What `scheme` actually resolves to right now (`system` collapsed against the OS preference). */
  resolved: 'light' | 'dark';
  /** Persist a new preference (PUT /api/settings). */
  setScheme: (next: ColorScheme) => void;
  /** True while the write is in flight. */
  isPending: boolean;
}

export function useColorScheme(): ColorSchemeController {
  const settings = useSettingsQuery();
  const { mutate, isPending } = useUpdateSettings();
  const scheme: ColorScheme = settings.data?.colorScheme ?? 'system';

  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Track the OS preference so `system` stays live.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;

  // Apply by toggling `.dark` on the document root.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setScheme = useCallback(
    (next: ColorScheme) => {
      mutate({ colorScheme: next });
    },
    [mutate],
  );

  return { scheme, resolved, setScheme, isPending };
}
