import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Localhost SPA (no SSR). Bound to loopback; the backend serves the API separately on 4317.
// `/api/*` is proxied to the backend (PLAN.md §7 Phase 4.5) so the frontend makes same-origin
// fetches in dev — no CORS, and the backend stays on 127.0.0.1 only (PLAN.md open Q #28).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4318,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
        // Proxy WebSocket upgrades too (the Today live-update socket at /api/ws — Phase 7a).
        ws: true,
      },
    },
  },
  build: { outDir: 'dist' },
});
