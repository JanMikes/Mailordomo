/**
 * @mailordomo/backend · credentials — the SINGLE security boundary for secrets (Golden rule #4;
 * PLAN.md §7 Phase 8, D33).
 *
 * Secrets live ONLY behind {@link CredentialStore}: IMAP/SMTP passwords, the metadata project token,
 * a (later) repo PAT. They are never written to the config JSON, returned by an API, logged, or sent
 * to the metadata service. {@link resolveCredentialStore} picks Keychain-first on macOS (D22), with a
 * `.env` fallback elsewhere or when `MAILORDOMO_CREDENTIALS=env`. Tests use
 * {@link createMemoryCredentialStore} (CI never invokes `security` or a real `.env`).
 */
import { resolveConfigDir } from '../settings';
import { createEnvFileCredentialStore } from './env-file';
import { createKeychainCredentialStore } from './keychain';
import type { CredentialStore } from './types';

export * from './types';
export * from './keychain';
export * from './env-file';
export * from './fake';

/** Which credential backend to use. `keychain` is the default on macOS; `env` is the dev fallback. */
export type CredentialBackend = 'keychain' | 'env';

/**
 * Decide the backend from the environment + platform. `MAILORDOMO_CREDENTIALS` forces it
 * (`keychain` | `env`); otherwise Keychain on macOS (`darwin`), `.env` everywhere else.
 */
export function resolveCredentialBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialBackend {
  const forced = env['MAILORDOMO_CREDENTIALS']?.trim().toLowerCase();
  if (forced === 'keychain' || forced === 'env') return forced;
  return platform === 'darwin' ? 'keychain' : 'env';
}

/**
 * Construct the real {@link CredentialStore} for this machine (Keychain-first per D22). The runnable
 * entry calls this; tests inject {@link createMemoryCredentialStore} instead.
 */
export function resolveCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  return resolveCredentialBackend(env, platform) === 'keychain'
    ? createKeychainCredentialStore()
    : createEnvFileCredentialStore(resolveConfigDir(env));
}
