/**
 * INTENT (separate test-author) — the D32 LANDING-VIEW control on the settings popover (the real
 * "never trapped" knob: the user can make the classic 3-pane their landing surface). ADDITIVE to
 * `settings-popover.intent.test.tsx` (which covers the stale-day / lock fields but, by an oversight,
 * mocks an AppSettings WITHOUT `defaultView` — so it never exercises this control).
 *
 * Derived from PROJECT.md §11 + D32: the control reflects the persisted `defaultView` and writes the
 * new value immediately on select (a segmented control, no Save) via `PUT /api/settings`. We mock
 * `@/lib/today-hooks` (where the component reads/writes settings) and assert the update mutation.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AppSettings } from '@mailordomo/shared';

const popover = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  settings: {
    waitingStaleDays: 3,
    needsReplyStaleDays: 2,
    lockTimeoutMinutes: 30,
    colorScheme: 'system',
    defaultView: 'today',
  } as AppSettings,
}));

vi.mock('@/lib/today-hooks', () => ({
  useSettingsQuery: () => ({ data: popover.settings }),
  useUpdateSettings: () => ({ mutate: popover.updateMutate, isPending: false }),
}));

import { SettingsPopover } from './settings-popover';

// jsdom lacks the pointer-capture / scroll APIs Radix touches when opening a popover.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  popover.updateMutate.mockReset();
  popover.settings = {
    waitingStaleDays: 3,
    needsReplyStaleDays: 2,
    lockTimeoutMinutes: 30,
    colorScheme: 'system',
    defaultView: 'today',
  };
});

describe('Landing-view control (D32)', () => {
  it('reflects the persisted defaultView (Today checked) on open', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const group = await screen.findByRole('radiogroup', { name: 'Landing view' });
    expect(within(group).getByRole('radio', { name: 'Today' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: '3-pane' })).not.toBeChecked();
  });

  it('selecting "3-pane" writes defaultView:"three-pane" immediately (no Save)', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const group = await screen.findByRole('radiogroup', { name: 'Landing view' });
    await user.click(within(group).getByRole('radio', { name: '3-pane' }));

    expect(popover.updateMutate).toHaveBeenCalledWith({ defaultView: 'three-pane' });
  });

  it('reflects a persisted 3-pane preference (3-pane checked) when that is the default', async () => {
    popover.settings = { ...popover.settings, defaultView: 'three-pane' };
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const group = await screen.findByRole('radiogroup', { name: 'Landing view' });
    expect(within(group).getByRole('radio', { name: '3-pane' })).toBeChecked();
  });
});
