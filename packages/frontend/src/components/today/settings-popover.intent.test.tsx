/**
 * INTENT (separate test-author) — `SettingsPopover` (PLAN.md D27/D29). The user-adjustable knobs that
 * feed the backend engines. Pins that the popover seeds its fields from the CURRENT settings and that
 * Save sends a partial patch of ONLY the edited field via the update mutation (which writes
 * `PUT /api/settings`). The component reads/writes through `@/lib/today-hooks`, so we mock those and
 * assert the mutation call.
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
});

describe('SettingsPopover', () => {
  it('seeds the fields from the current settings when opened', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByLabelText('Waiting goes stale after')).toHaveValue(3);
    expect(screen.getByLabelText('Needs-reply goes stale after')).toHaveValue(2);
    expect(screen.getByLabelText('Thread lock timeout')).toHaveValue(30);
  });

  it('Save sends a partial patch of only the edited field', async () => {
    const user = userEvent.setup();
    render(<SettingsPopover />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));

    const waiting = screen.getByLabelText('Waiting goes stale after');
    await user.clear(waiting);
    await user.type(waiting, '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(popover.updateMutate).toHaveBeenCalledTimes(1);
    // Only the changed knob is patched — the untouched defaults are NOT resent.
    expect(popover.updateMutate.mock.calls[0]?.[0]).toEqual({ waitingStaleDays: 5 });
  });
});
