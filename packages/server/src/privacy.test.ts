/**
 * Privacy boundary, END-TO-END through the API (Golden rule #3: "Email bodies never leave the local
 * machine"; PROJECT.md §5; PLAN.md §7 Phase 2 "never-stores-body assertion").
 *
 * The shared package already proves the strict DTOs reject body keys at the schema level. This suite
 * proves the same INVARIANT survives all the way through the live HTTP service: posting any
 * body-bearing payload to a write endpoint is REJECTED with 400 (strict-object validation) and
 * stores nothing — so no raw email / draft body can ever be persisted server-side.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_SERVER_PAYLOAD_KEYS } from '@mailordomo/shared';
import type { Hono } from 'hono';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { authHeaders, PROJECT_A, makeApp, readJson, seedProject, seedThread } from './test-helpers';

interface EndpointSpec {
  readonly name: string;
  readonly path: string;
  readonly list: string;
  /** A valid base payload that, on its own, the endpoint accepts. */
  readonly base: () => Record<string, unknown>;
  /** Extra keys to inject beyond FORBIDDEN_SERVER_PAYLOAD_KEYS (bare body/content where illegal). */
  readonly extraForbidden: readonly string[];
}

const LEAK_VALUE = 'From: attacker\\n\\nThe full raw email body that must never leave the machine.';

describe('privacy boundary — the server rejects every body-bearing payload', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;
  let threadId: string;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
    threadId = seedThread(repo, PROJECT_A.id).id;
  });

  afterEach(() => {
    repo.close();
  });

  const specs = (): EndpointSpec[] => [
    {
      name: 'POST /threads',
      path: '/threads',
      list: '/threads',
      base: () => ({
        project_id: PROJECT_A.id,
        mailbox_address: 'jan@acme.com',
        root_message_id: '<privacy@host>',
        subject: 'Subject',
        snippet: 'snippet',
        sender: 'Petr <petr@acme.com>',
      }),
      // threads declare no `body`/`content` — both must be rejected here.
      extraForbidden: ['body', 'content'],
    },
    {
      name: 'POST /tasks',
      path: '/tasks',
      list: '/tasks',
      base: () => ({ thread_id: threadId }),
      extraForbidden: ['body', 'content'],
    },
    {
      name: 'POST /promises',
      path: '/promises',
      list: '/promises',
      base: () => ({ thread_id: threadId, direction: 'my-promise', text: 'Send it', actor: 'jan' }),
      extraForbidden: ['body', 'content'],
    },
    {
      name: 'POST /notes',
      path: '/notes',
      list: '/notes',
      // `body` is the sanctioned user-note field here, so it is NOT forbidden; `content` still is.
      base: () => ({ thread_id: threadId, author: 'jan', body: 'a user note' }),
      extraForbidden: ['content'],
    },
    {
      name: 'POST /drafts',
      path: '/drafts',
      list: '/drafts',
      base: () => ({ thread_id: threadId, version: 1, model: 'opus', author: 'claude' }),
      // DraftMeta is metadata-only: neither a draft `body` nor `content` may ride along.
      extraForbidden: ['body', 'content'],
    },
    {
      name: 'POST /repos',
      path: '/repos',
      list: '/repos',
      base: () => ({
        project_id: PROJECT_A.id,
        name: 'app',
        git_url: 'git@github.com:acme/app.git',
      }),
      extraForbidden: ['body', 'content'],
    },
  ];

  const count = async (listPath: string): Promise<number> => {
    const rows = await readJson<unknown[]>(
      await app.request(listPath, { headers: authHeaders(PROJECT_A) }),
    );
    return rows.length;
  };

  for (const spec of specs()) {
    describe(spec.name, () => {
      const keys = [...FORBIDDEN_SERVER_PAYLOAD_KEYS, ...spec.extraForbidden];

      it.each(keys)('rejects an injected "%s" key with 400 and stores nothing', async (key) => {
        const before = await count(spec.list);
        const res = await app.request(spec.path, {
          method: 'POST',
          headers: authHeaders(PROJECT_A),
          body: JSON.stringify({ ...spec.base(), [key]: LEAK_VALUE }),
        });
        expect(res.status).toBe(400);
        expect(await count(spec.list)).toBe(before);
      });

      it('accepts the clean base payload (control — the key, not the base, is what fails)', async () => {
        const res = await app.request(spec.path, {
          method: 'POST',
          headers: authHeaders(PROJECT_A),
          body: JSON.stringify(spec.base()),
        });
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
      });
    });
  }

  it('DraftMeta creation cannot carry a draft body under any common key', async () => {
    for (const key of ['body', 'draftBody', 'draft_body', 'content', 'emlContent']) {
      const res = await app.request('/drafts', {
        method: 'POST',
        headers: authHeaders(PROJECT_A),
        body: JSON.stringify({
          thread_id: threadId,
          version: 1,
          model: 'opus',
          author: 'claude',
          [key]: 'the secret draft text',
        }),
      });
      expect(res.status).toBe(400);
    }
    // and nothing was stored
    expect(
      (
        await readJson<unknown[]>(
          await app.request(`/drafts?thread_id=${threadId}`, { headers: authHeaders(PROJECT_A) }),
        )
      ).length,
    ).toBe(0);
  });

  it('tone PUT rejects a smuggled raw-email key even though it legitimately carries content', async () => {
    const res = await app.request('/tone', {
      method: 'PUT',
      headers: authHeaders(PROJECT_A),
      body: JSON.stringify({
        project_id: PROJECT_A.id,
        scope: 'project',
        path: 'project/acme.md',
        content: 'derived tone memory',
        version_hash: 'h1',
        updated_by: 'jan',
        updated_at: '2026-06-05T12:00:00Z',
        emlContent: LEAK_VALUE,
      }),
    });
    expect(res.status).toBe(400);
  });
});
