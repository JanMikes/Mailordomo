/**
 * Optional boot-time project seeding. Pairing verifies an EXISTING project's token, so a project
 * must be provisioned out of band. When `METADATA_PROJECT_ID` + `METADATA_PROJECT_TOKEN` are set we
 * upsert that project, storing only the token's HASH (Golden rule #4) — making a fresh container
 * immediately pairable. Re-running rotates the stored hash if the token changes.
 */
import type { ServerEnv } from './env';
import { hashToken } from './auth';
import type { Repository } from './repo/repository';

export function seedProjectFromEnv(repo: Repository, env: ServerEnv): void {
  const { seedProjectId, seedProjectToken } = env;
  if (seedProjectId === undefined || seedProjectToken === undefined) return;
  repo.upsertProject({
    id: seedProjectId,
    name: env.seedProjectName ?? seedProjectId,
    token_hash: hashToken(seedProjectToken),
  });
}
