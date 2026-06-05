/**
 * INTENT (separate test-author) — `TaskCountsBar` (PROJECT.md §11 done-vs-remaining). Pins the
 * "N remaining · N done" copy, the computed done-ratio on the progressbar, and the zero-total guard
 * (no division by zero). Pure component.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TaskCountsBar } from './task-counts-bar';

describe('TaskCountsBar', () => {
  it('shows "N remaining · N done" and the done ratio on the progressbar', () => {
    const { container } = render(<TaskCountsBar counts={{ remaining: 3, done: 5 }} />);

    const line = container.querySelector('p');
    expect(line?.textContent).toMatch(/3\s*remaining/);
    expect(line?.textContent).toMatch(/5\s*done/);
    // 5 done of 8 total → 63%.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63');
    expect(screen.getByText('63%')).toBeInTheDocument();
  });

  it('handles the empty project (0/0) without a NaN ratio', () => {
    const { container } = render(<TaskCountsBar counts={{ remaining: 0, done: 0 }} />);
    expect(container.querySelector('p')?.textContent).toMatch(/0\s*remaining/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
