/**
 * The CredentialStore seam (PLAN.md §7 Phase 8, decision D33) — the SINGLE security boundary for
 * secrets (Golden rule #4).
 *
 * Secrets — IMAP/SMTP passwords, the metadata project token, a (later) repo PAT — live ONLY behind
 * this interface. They are NEVER written to the config JSON, returned by any API, logged, or sent to
 * the metadata service. The store is keyed by `(account, kind)`:
 *   - `account` is the owning entity's id (a mailbox id for imap/smtp; a project id for
 *     metadata-token; a repo-pointer id for repo-pat).
 *   - `kind` selects the slot ({@link CredentialKind}).
 *
 * Three implementations:
 *   - Keychain (`createKeychainCredentialStore`) — macOS `security` CLI, the Keychain-first default
 *     (D22/#22).
 *   - `.env` fallback (`createEnvFileCredentialStore`) — a per-account `{account}.env` (gitignored)
 *     for dev / non-macOS.
 *   - In-memory fake (`createMemoryCredentialStore`) — for tests. CI MUST use this; it NEVER invokes
 *     `security` or touches a real `.env`.
 */
import type { CredentialKind } from '@mailordomo/shared';

export type { CredentialKind };

/**
 * Read/write/delete a single secret keyed by `(account, kind)`. All methods are async (the Keychain
 * impl spawns a process). `get` resolves to `undefined` when no secret is stored; `set` is an upsert;
 * `delete` is idempotent (deleting an absent secret is a no-op).
 *
 * SECURITY CONTRACT (every impl upholds it): no method ever logs the secret or includes it in a
 * thrown error message. `get` is the ONLY method that returns a secret value, and only to its direct
 * caller (the backend's transport/test-connection paths) — never across an API boundary.
 */
export interface CredentialStore {
  get(account: string, kind: CredentialKind): Promise<string | undefined>;
  set(account: string, kind: CredentialKind, secret: string): Promise<void>;
  delete(account: string, kind: CredentialKind): Promise<void>;
}

/**
 * Guard an `account` used to derive a Keychain service name or a `.env` filename. Rejects path
 * separators / traversal and empty values so a crafted account id can't escape the config dir or the
 * keychain namespace. Allows the id alphabet (`A–Z a–z 0–9 . _ @ -`) — covers generated ids + email
 * local parts. Throws on a bad value (callers pass generated ids, so this only trips on misuse).
 */
export function assertSafeAccount(account: string): void {
  if (!/^[A-Za-z0-9._@-]+$/.test(account)) {
    throw new Error('invalid credential account (must match [A-Za-z0-9._@-]+)');
  }
}
