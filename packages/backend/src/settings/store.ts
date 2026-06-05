/**
 * The LOCAL settings store (PLAN.md §7 Phase 7a, decisions D27/D29).
 *
 * Settings are machine-local app config in a JSON file — NOT metadata-server state (Golden rule #2)
 * and NOT browser localStorage-as-truth (code conventions). The backend owns the file; the frontend
 * reads/writes it only through `GET`/`PUT /api/settings`. The store is deliberately tiny and
 * synchronous (a single small file, read on demand) so it is trivial to inject in tests.
 *
 * Robustness: `read()` NEVER throws on a missing/corrupt file — it returns {@link DEFAULT_APP_SETTINGS}
 * so the app is always usable. `write()` deep-merges the patch over the current settings, VALIDATES
 * the result with the shared schema, and persists ATOMICALLY (temp file + rename) so a crash mid-write
 * can never leave a half-written, invalid config.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AppSettings } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from '@mailordomo/shared';

/** Read the current settings, or persist a patch over them, returning the resulting settings. */
export interface SettingsStore {
  read(): AppSettings;
  write(patch: Partial<AppSettings>): AppSettings;
}

/** The settings file name within the config dir. */
export const SETTINGS_FILE_NAME = 'settings.json';

/**
 * Resolve the settings.json path from `$MAILORDOMO_CONFIG_DIR` (default `~/.mailordomo/`). The
 * runnable entry calls this; tests pass an explicit temp path to {@link createFileSettingsStore}.
 */
export function resolveSettingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['MAILORDOMO_CONFIG_DIR']?.trim();
  const dir = configured && configured.length > 0 ? configured : join(homedir(), '.mailordomo');
  return join(dir, SETTINGS_FILE_NAME);
}

/** A file-backed {@link SettingsStore} at `filePath` (the full path to settings.json). */
export function createFileSettingsStore(filePath: string): SettingsStore {
  function read(): AppSettings {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      // ENOENT or any read error → defaults. Graceful by design (never throws).
      return { ...DEFAULT_APP_SETTINGS };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_APP_SETTINGS };
    }
    const parsed = AppSettingsSchema.safeParse(json);
    return parsed.success ? parsed.data : { ...DEFAULT_APP_SETTINGS };
  }

  function write(patch: Partial<AppSettings>): AppSettings {
    // Merge over the CURRENT on-disk settings (themselves defaulted if absent), then validate the
    // whole object — a bad value (e.g. a non-positive threshold) throws here, never reaching disk.
    const merged = AppSettingsSchema.parse({ ...read(), ...patch });
    mkdirSync(dirname(filePath), { recursive: true });
    // Atomic write: a temp sibling then rename over the target (rename is atomic on the same fs).
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
    return merged;
  }

  return { read, write };
}
