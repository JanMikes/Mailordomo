/**
 * LIGHT smoke (Implementer) — the D32 "Landing view" control added to the settings popover. The
 * exhaustive settings suite is the separate test-author's; here we only prove the `defaultView`
 * segmented control reflects the current setting and PUTs the new value immediately on select (the
 * real "never trapped" knob — persisted in AppSettings, not localStorage).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  popover.updateMutate.mockReset();
});

describe('SettingsPopover — landing view (D32)', () => {
  it('reflects the current defaultView as the checked option', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('radio', { name: 'Today' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '3-pane' })).not.toBeChecked();
  });

  it('selecting 3-pane PUTs defaultView immediately (no Save needed)', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    await user.click(screen.getByRole('radio', { name: '3-pane' }));
    expect(popover.updateMutate).toHaveBeenCalledWith({ defaultView: 'three-pane' });
  });
});
