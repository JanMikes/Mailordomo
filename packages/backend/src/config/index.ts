/**
 * @mailordomo/backend · config — the LOCAL structured config store (PLAN.md §7 Phase 8, D33).
 *
 * A JSON file at `$MAILORDOMO_CONFIG_DIR/config.json` holding NON-SECRET config (projects → mailboxes
 * → repos), mirroring the settings store. Passwords/tokens are NEVER here — they live in the
 * `credentials/` {@link CredentialStore}, referenced by id. The provider presets are pure data in
 * `@mailordomo/shared` (`PROVIDER_PRESETS`) so the wizard frontend shares them.
 */
export * from './store';
export * from './mutations';
