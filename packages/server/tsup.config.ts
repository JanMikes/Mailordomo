import { defineConfig } from 'tsup';

/**
 * Bundle the server to a single ESM file for the Docker runtime.
 *
 * `noExternal` force-INLINES the workspace `@mailordomo/shared` TS source (consumed directly, no
 * separate build) plus its pure-JS deps (zod, hono, @hono/node-server), so the runtime image only
 * needs the ONE thing that cannot be bundled: the native `better-sqlite3` binary (kept external and
 * installed in the runtime stage). See Dockerfile.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  noExternal: [/^@mailordomo\/shared/, /^zod/, /^hono/, /^@hono\//],
  external: ['better-sqlite3'],
});
