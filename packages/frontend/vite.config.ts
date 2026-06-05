import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Localhost SPA (no SSR). Bound to loopback; the backend serves the API separately on 4317.
//
// Tailwind v4 is wired via the official `@tailwindcss/vite` plugin (the v4 path on Vite 8 — NOT the
// v3 PostCSS setup). `@` aliases the package `src/` (the shadcn convention, so `@/components/ui/...`
// and `@/lib/...` resolve here and for any future `npx shadcn add`).
//
// `/api/*` (REST + the Today WS, `ws:true`) is proxied to the backend (PLAN.md §7 Phase 4.5/7a) so
// the frontend makes same-origin requests in dev — no CORS, backend stays on 127.0.0.1 only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4318,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: { outDir: 'dist' },
});
