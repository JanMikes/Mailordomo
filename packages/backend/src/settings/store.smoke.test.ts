/**
 * SMOKE — the file-backed {@link createFileSettingsStore} (D27/D29). Proves the load-bearing
 * robustness contract: defaults on a missing/corrupt file (never throws), a persisted round-trip,
 * deep-merge over current, schema validation on write, and the env-based path resolution.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { createFileSettingsStore, resolveSettingsFilePath, SETTINGS_FILE_NAME } from './store';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mailordomo-settings-'));
  file = join(dir, SETTINGS_FILE_NAME);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createFileSettingsStore', () => {
  it('read() returns defaults when the file is missing (never throws)', () => {
    const store = createFileSettingsStore(file);
    expect(store.read()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('read() returns defaults when the file is corrupt JSON', () => {
    writeFileSync(file, 'not json at all', 'utf8');
    expect(createFileSettingsStore(file).read()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('write() persists a deep-merge over current and survives a fresh store', () => {
    const store = createFileSettingsStore(file);
    const updated = store.write({ waitingStaleDays: 9, colorScheme: 'dark' });
    expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, waitingStaleDays: 9, colorScheme: 'dark' });
    // A new store instance reads the persisted file (not just in-memory state).
    expect(createFileSettingsStore(file).read()).toEqual(updated);
    // A second patch merges over the first (does not reset untouched keys).
    expect(store.write({ lockTimeoutMinutes: 45 })).toEqual({
      ...DEFAULT_APP_SETTINGS,
      waitingStaleDays: 9,
      colorScheme: 'dark',
      lockTimeoutMinutes: 45,
    });
  });

  it('write() rejects an invalid value via the shared schema', () => {
    const store = createFileSettingsStore(file);
    expect(() => store.write({ waitingStaleDays: 0 })).toThrow();
  });

  it('resolveSettingsFilePath honors $MAILORDOMO_CONFIG_DIR, else defaults to ~/.mailordomo', () => {
    expect(resolveSettingsFilePath({ MAILORDOMO_CONFIG_DIR: '/tmp/cfg' })).toBe(
      join('/tmp/cfg', SETTINGS_FILE_NAME),
    );
    const def = resolveSettingsFilePath({});
    expect(def.endsWith(join('.mailordomo', SETTINGS_FILE_NAME))).toBe(true);
  });
});
