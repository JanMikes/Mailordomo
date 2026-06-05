/**
 * INTENT (separate test-author) — `MetricCard` (PROJECT.md §7/§11): one 3-way promise tile. Pins that
 * it renders the direction label + action, the live open count, the overdue call-out (or the
 * on-track/all-clear copy), the total, and that the count adopts the DIRECTION's semantic hue —
 * green (deliver) / amber (owe) / blue (chase). Pure component; no providers needed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArrowDownLeft, ArrowUpRight, Clock } from 'lucide-react';
import type { TodayPromiseMetric } from '@mailordomo/shared';

import { PROMISE_META } from '@/lib/labels';
import { MetricCard } from './metric-card';

describe('MetricCard', () => {
  it('green (my promises): label, open count in the deliver hue, overdue call-out, total', () => {
    const metric: TodayPromiseMetric = { total: 7, openCount: 4, overdueCount: 2 };
    render(<MetricCard meta={PROMISE_META['my-promise']} Icon={ArrowUpRight} metric={metric} />);

    expect(screen.getByText('My promises')).toBeInTheDocument();
    expect(screen.getByText('Deliver')).toBeInTheDocument();
    expect(screen.getByText('4')).toHaveClass('text-promise-deliver'); // open count, deliver color
    expect(screen.getByText('2 overdue')).toHaveClass('text-destructive');
    expect(screen.getByText('7 total')).toBeInTheDocument();
  });

  it('amber (they asked): "on track" when nothing is overdue, count in the owe hue', () => {
    const metric: TodayPromiseMetric = { total: 3, openCount: 1, overdueCount: 0 };
    render(<MetricCard meta={PROMISE_META['they-asked']} Icon={ArrowDownLeft} metric={metric} />);

    expect(screen.getByText('They asked')).toBeInTheDocument();
    expect(screen.getByText('You owe')).toBeInTheDocument();
    expect(screen.getByText('1')).toHaveClass('text-promise-owe');
    expect(screen.getByText('on track')).toBeInTheDocument();
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
    expect(screen.getByText('3 total')).toBeInTheDocument();
  });

  it('blue (awaiting them): "all clear" at zero open, count in the chase hue', () => {
    const metric: TodayPromiseMetric = { total: 5, openCount: 0, overdueCount: 0 };
    render(<MetricCard meta={PROMISE_META['awaiting-them']} Icon={Clock} metric={metric} />);

    expect(screen.getByText('Awaiting them')).toBeInTheDocument();
    expect(screen.getByText('Chase')).toBeInTheDocument();
    expect(screen.getByText('0')).toHaveClass('text-promise-chase');
    expect(screen.getByText('all clear')).toBeInTheDocument();
    expect(screen.getByText('5 total')).toBeInTheDocument();
  });
});
