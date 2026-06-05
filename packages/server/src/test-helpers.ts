/**
 * Shared fixtures for the metadata-service test suite (Phase 2). Not a test file itself (Vitest only
 * runs `*.test.ts`), but it lives under `src` so it passes the same strict typecheck / lint / format
 * gate as production code.
 *
 * Provides: a fresh in-memory (fully migrated) app + repo, project seeding that stores ONLY the
 * token hash exactly as production does (Golden rule #4), authed-request headers, a thread seeder,
 * a typed JSON reader, and a narrowing `assertDefined`.
 */
import type { Hono } from 'hono';
import type { Thread } from '@mailordomo/shared';
import { createApp } from './app';
import { hashToken, PROJECT_ID_HEADER } from './auth';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { createSqliteRepository, IN_MEMORY_DB } from './repo/sqlite';
import { nowIso } from './time';

export interface TestProject {
  readonly id: string;
  readonly name: string;
  readonly token: string;
}

/** Two distinct seedable projects for auth + cross-project-scoping tests. */
export const PROJECT_A: TestProject = { id: 'project-a', name: 'Acme', token: 'token-a-secret' };
export const PROJECT_B: TestProject = { id: 'project-b', name: 'Globex', token: 'token-b-secret' };

/** A fresh in-memory, fully-migrated app + repo. Call `repo.close()` in an `afterEach`. */
export function makeApp(): { app: Hono<AppEnv>; repo: Repository } {
  const repo = createSqliteRepository(IN_MEMORY_DB);
  const app = createApp({ repo });
  return { app, repo };
}

/** Seed a project, storing only the token's sha256 hash (Golden rule #4) — as production does. */
export function seedProject(repo: Repository, project: TestProject): void {
  repo.upsertProject({ id: project.id, name: project.name, token_hash: hashToken(project.token) });
}

/** Headers that authenticate as `project` for a data route (+ a JSON content type). */
export function authHeaders(project: { id: string; token: string }): Record<string, string> {
  return {
    authorization: `Bearer ${project.token}`,
    [PROJECT_ID_HEADER]: project.id,
    'content-type': 'application/json',
  };
}

/** Insert a thread directly via the repo, for tests that need a `thread_id` without going via HTTP. */
export function seedThread(
  repo: Repository,
  projectId: string,
  rootMessageId = '<root@host>',
): Thread {
  return repo.upsertThread(
    projectId,
    {
      project_id: projectId,
      mailbox_address: 'jan@acme.com',
      root_message_id: rootMessageId,
      subject: 'Quarterly report',
      snippet: 'Could you send the quarterly report?',
      sender: 'Petr <petr@acme.com>',
      last_message_at: null,
    },
    nowIso(),
  );
}

/** Read a `Response` body as JSON, typed by the caller (the test owns the expected shape). */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Assert a value is defined, narrowing its type for the subsequent assertions. */
export function assertDefined<T>(value: T | undefined, label = 'value'): asserts value is T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
}
