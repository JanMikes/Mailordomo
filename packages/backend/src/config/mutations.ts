/**
 * PURE config mutations (PLAN.md §7 Phase 8, D33) — small, side-effect-free functions over a
 * {@link MailordomoConfig} that the wizard endpoints apply via `ConfigStore.update`. Keeping them pure
 * (no IO, no id generation, no clock) makes them trivially unit-testable; the handler generates ids +
 * persists. Each returns a NEW config; conflicts throw a typed {@link ConfigError} the API maps to a
 * 409. NONE of these accept or carry a secret (Golden rule #4).
 */
import type {
  LocalRepoConfig,
  MailboxConfig,
  MailordomoConfig,
  ProjectConfig,
  RepoPointer,
} from '@mailordomo/shared';

/** A config-level conflict (duplicate id, unknown reference). `code` lets the API pick a status. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: 'conflict' | 'not_found',
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Append a project. Throws on a duplicate id. */
export function addProject(config: MailordomoConfig, project: ProjectConfig): MailordomoConfig {
  if (config.projects.some((p) => p.id === project.id)) {
    throw new ConfigError(`project id "${project.id}" already exists`, 'conflict');
  }
  return { ...config, projects: [...config.projects, project] };
}

/**
 * Append a mailbox. Throws if its `projectId` is unknown, its id duplicates an existing one, or its
 * address is already configured under the same project.
 */
export function addMailbox(config: MailordomoConfig, mailbox: MailboxConfig): MailordomoConfig {
  if (!config.projects.some((p) => p.id === mailbox.projectId)) {
    throw new ConfigError(`unknown project "${mailbox.projectId}"`, 'not_found');
  }
  if (config.mailboxes.some((m) => m.id === mailbox.id)) {
    throw new ConfigError(`mailbox id "${mailbox.id}" already exists`, 'conflict');
  }
  if (
    config.mailboxes.some((m) => m.projectId === mailbox.projectId && m.address === mailbox.address)
  ) {
    throw new ConfigError(
      `mailbox "${mailbox.address}" already configured for this project`,
      'conflict',
    );
  }
  return { ...config, mailboxes: [...config.mailboxes, mailbox] };
}

/** Patch a mailbox's NON-secret fields in place (by id). Throws if the id is unknown. */
export function updateMailbox(
  config: MailordomoConfig,
  id: string,
  patch: Partial<Omit<MailboxConfig, 'id' | 'projectId'>>,
): MailordomoConfig {
  if (!config.mailboxes.some((m) => m.id === id)) {
    throw new ConfigError(`unknown mailbox "${id}"`, 'not_found');
  }
  return {
    ...config,
    mailboxes: config.mailboxes.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  };
}

/**
 * Remove a mailbox by id. Throws `not_found` if absent. Pure over config: it drops only the NON-secret
 * mailbox entry — the API handler separately clears that mailbox's credentials from the CredentialStore
 * (Golden rule #4: this module never touches secrets).
 */
export function removeMailbox(config: MailordomoConfig, id: string): MailordomoConfig {
  if (!config.mailboxes.some((m) => m.id === id)) {
    throw new ConfigError(`unknown mailbox "${id}"`, 'not_found');
  }
  return { ...config, mailboxes: config.mailboxes.filter((m) => m.id !== id) };
}

/**
 * Upsert a linked repo: the shareable {@link RepoPointer} identity (into `repoPointers`) + the
 * machine-local {@link LocalRepoConfig} (into `repos`), keyed by `pointer.id` / `repo_pointer_id`. The
 * caller guarantees `local.repo_pointer_id === pointer.id`. Re-linking the same id replaces both.
 */
export function linkRepo(
  config: MailordomoConfig,
  pointer: RepoPointer,
  local: LocalRepoConfig,
): MailordomoConfig {
  const repoPointers = config.repoPointers.some((p) => p.id === pointer.id)
    ? config.repoPointers.map((p) => (p.id === pointer.id ? pointer : p))
    : [...config.repoPointers, pointer];
  const repos = config.repos.some((r) => r.repo_pointer_id === local.repo_pointer_id)
    ? config.repos.map((r) => (r.repo_pointer_id === local.repo_pointer_id ? local : r))
    : [...config.repos, local];
  return { ...config, repoPointers, repos };
}
