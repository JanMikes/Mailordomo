import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn/ui `cn()` helper: merge conditional class lists (clsx) and de-conflict overlapping
 * Tailwind utilities (tailwind-merge), so a later `className` wins over a component default
 * (e.g. passing `bg-accent` overrides a base `bg-card`). Used by every UI primitive.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
