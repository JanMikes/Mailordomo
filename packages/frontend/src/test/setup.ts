/**
 * Vitest setup (jsdom). Installs `@testing-library/jest-dom` matchers onto Vitest's `expect`
 * (`toBeInTheDocument`, `toBeDisabled`, …) and unmounts the React tree after every test so the
 * jsdom document never leaks between cases. The test-author's component suite relies on this env.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
