import { defineConfig } from 'tsup';

/**
 * The backend builds two ESM entries:
 *  - `src/index.ts`     — the library barrel (consumed in-repo via source; the build is a buildability gate).
 *  - `src/api/server.ts` — the RUNNABLE server (`npm start` / launchd). It is executed directly by Node's
 *    ESM loader, so its JS dependencies are BUNDLED here — otherwise Node rejects CJS-style directory
 *    imports inside deps (e.g. `nodemailer/lib/mail-composer`) with ERR_UNSUPPORTED_DIR_IMPORT.
 *
 * The ONLY external is the native `better-sqlite3` (it loads a prebuilt `.node` addon and must not be
 * bundled). Everything else (hono, imapflow, mailparser, nodemailer, ws, @mailordomo/shared) is inlined,
 * so `dist/api/server.js` is self-contained apart from that one native module.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/api/server.ts'],
  format: 'esm',
  clean: true,
  silent: true,
  // Bundle ONLY the `@mailordomo/shared` workspace package — it resolves to TS SOURCE whose extensionless
  // imports (`./primitives`) Node's ESM loader can't resolve, so it must be inlined. Every third-party dep
  // stays EXTERNAL and is loaded from node_modules by Node natively: that avoids bundling CJS packages that
  // `require()` Node built-ins (e.g. better-sqlite3 → `require('fs')`, mailparser's mailsplit → `require('stream')`),
  // which esbuild's ESM output cannot shim. (The one deep dir-import, `nodemailer/lib/mail-composer`, is made
  // explicit with `/index.js` at its import site so the external resolution works under Node ESM.)
  noExternal: ['@mailordomo/shared'],
});
