import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Localhost SPA (no SSR). Bound to loopback; the backend serves the API separately.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4318 },
  build: { outDir: 'dist' },
});
