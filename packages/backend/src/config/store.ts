/**
 * The LOCAL config store (PLAN.md §7 Phase 8, decision D33) — structured NON-SECRET app config in a
 * JSON file at `$MAILORDOMO_CONFIG_DIR/config.json`, mirroring the {@link SettingsStore} pattern.
 *
 * Holds projects → mailboxes → repos. GOLDEN RULE #4: NO passwords/tokens live here — those are in
 * the {@link CredentialStore}, referenced by mailbox/project/repo id. The shared `MailordomoConfig`
 * schema is a `strictObject` with no secret field, so a smuggled password cannot even be persisted.
 *
 * Robustness (mirrors the settings store): `read()` NEVER throws on a missing/corrupt file — it
 * returns {@link DEFAULT_MAILORDOMO_CONFIG}. Writes VALIDATE the whole object against the shared
 * schema and persist ATOMICALLY (temp file + rename), so a crash mid-write can't leave invalid config.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MailordomoConfig } from '@mailordomo/shared';
import { DEFAULT_MAILORDOMO_CONFIG, MailordomoConfigSchema } from '@mailordomo/shared';
import { resolveConfigDir } from '../settings';

/** Read the whole config, replace it, or apply a pure update over it. */
export interface ConfigStore {
  /** The current config, or {@link DEFAULT_MAILORDOMO_CONFIG} when the file is missing/corrupt. */
  read(): MailordomoConfig;
  /** Replace the whole config (validated + persisted atomically). Returns the stored value. */
  write(next: MailordomoConfig): MailordomoConfig;
  /** Apply a pure update over the current config, then validate + persist. Returns the result. */
  update(fn: (current: MailordomoConfig) => MailordomoConfig): MailordomoConfig;
}

/** The config file name within the config dir. */
export const CONFIG_FILE_NAME = 'config.json';

/** Resolve `$MAILORDOMO_CONFIG_DIR/config.json` (default `~/.mailordomo/config.json`). */
export function resolveConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigDir(env), CONFIG_FILE_NAME);
}

/** A file-backed {@link ConfigStore} at `filePath` (the full path to config.json). */
export function createFileConfigStore(filePath: string): ConfigStore {
  function read(): MailordomoConfig {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return structuredClone(DEFAULT_MAILORDOMO_CONFIG);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return structuredClone(DEFAULT_MAILORDOMO_CONFIG);
    }
    const parsed = MailordomoConfigSchema.safeParse(json);
    return parsed.success ? parsed.data : structuredClone(DEFAULT_MAILORDOMO_CONFIG);
  }

  function write(next: MailordomoConfig): MailordomoConfig {
    // Validate the WHOLE object — a bad/extra field (e.g. a smuggled password) throws here, never
    // reaching disk.
    const validated = MailordomoConfigSchema.parse(next);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
    return validated;
  }

  function update(fn: (current: MailordomoConfig) => MailordomoConfig): MailordomoConfig {
    return write(fn(read()));
  }

  return { read, write, update };
}
