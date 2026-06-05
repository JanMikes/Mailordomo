/**
 * Vitest setup (jsdom). Installs `@testing-library/jest-dom` matchers onto Vitest's `expect`
 * (`toBeInTheDocument`, `toBeDisabled`, …) and unmounts the React tree after every test so the
 * jsdom document never leaks between cases. The test-author's component suite relies on this env.
 *
 * It also polyfills the few browser APIs jsdom omits that Radix primitives touch — `ResizeObserver`
 * (ScrollArea), `Element.scrollIntoView` (the refine chat auto-scroll), and pointer-capture (Radix
 * dialogs/triggers) — so component tests can render the 7b work surface + alert-dialog. Each is
 * guarded so it never clobbers a real implementation.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (typeof Element !== 'undefined') {
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
  if (typeof Element.prototype.hasPointerCapture !== 'function') {
    Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
      return false;
    };
  }
  if (typeof Element.prototype.setPointerCapture !== 'function') {
    Element.prototype.setPointerCapture = function setPointerCapture(): void {};
  }
  if (typeof Element.prototype.releasePointerCapture !== 'function') {
    Element.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  }
}
