/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Test-only config (Vitest prefers `vitest.config.ts` over `vite.config.ts`). It deliberately OMITS
// the `@tailwindcss/vite` plugin — component tests assert structure/behavior, not computed CSS, so
// there's no need to compile the stylesheet on every jsdom run. The `@` alias mirrors `vite.config.ts`
// so `@/...` imports resolve identically in tests. `setup.ts` installs jest-dom matchers + auto-cleanup.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
