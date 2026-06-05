/**
 * Auth & pairing (PROJECT.md §3 Layer 2; Golden rule #4; PLAN.md §7 Phase 2 "auth accept/reject").
 *
 * Intent derived BEFORE reading the impl: a project authenticates with a bearer token (stored only
 * as a hash) plus the `X-Project-Id` header. A missing/wrong token is 401; a body `project_id` that
 * disagrees with the authed project is 403 (a scoping breach). `/health` and `/pair` are the only
 * routes reachable without auth, and `/pair` IS the credential check (correct token ok, wrong
 * rejected, and it never echoes the token hash).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { AuthedProject, PairResponse } from '@mailordomo/shared';
import type { AppEnv } from './http';
import type { Repository } from './repo/repository';
import { authHeaders, PROJECT_A, makeApp, readJson, seedProject } from './test-helpers';

describe('auth & pairing', () => {
  let app: Hono<AppEnv>;
  let repo: Repository;

  beforeEach(() => {
    ({ app, repo } = makeApp());
    seedProject(repo, PROJECT_A);
  });

  afterEach(() => {
    repo.close();
  });

  describe('public routes (no auth)', () => {
    it('GET /health is reachable without any auth headers', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('POST /pair verifies an existing project with the correct token', async () => {
      const res = await app.request('/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_A.id, token: PROJECT_A.token }),
      });
      expect(res.status).toBe(200);
      const body = await readJson<PairResponse>(res);
      expect(body.project).toEqual({ id: PROJECT_A.id, name: PROJECT_A.name });
    });

    it('POST /pair NEVER returns the token hash', async () => {
      const res = await app.request('/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_A.id, token: PROJECT_A.token }),
      });
      const body = await readJson<{ project: AuthedProject & Record<string, unknown> }>(res);
      expect(body.project).not.toHaveProperty('token_hash');
    });

    it('POST /pair rejects a wrong token with 401', async () => {
      const res = await app.request('/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_A.id, token: 'not-the-token' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST /pair rejects an unknown project with 401', async () => {
      const res = await app.request('/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: 'no-such-project', token: PROJECT_A.token }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('data routes require a valid project bearer token', () => {
    it('accepts a valid token + project id with 200', async () => {
      const res = await app.request('/threads', { headers: authHeaders(PROJECT_A) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('rejects a missing Authorization header with 401', async () => {
      const res = await app.request('/threads', { headers: { 'x-project-id': PROJECT_A.id } });
      expect(res.status).toBe(401);
    });

    it('rejects a missing X-Project-Id header with 401', async () => {
      const res = await app.request('/threads', {
        headers: { authorization: `Bearer ${PROJECT_A.token}` },
      });
      expect(res.status).toBe(401);
    });

    it('rejects a malformed Authorization header (not Bearer) with 401', async () => {
      const res = await app.request('/threads', {
        headers: { authorization: PROJECT_A.token, 'x-project-id': PROJECT_A.id },
      });
      expect(res.status).toBe(401);
    });

    it('rejects a wrong token for a real project with 401', async () => {
      const res = await app.request('/threads', {
        headers: { authorization: 'Bearer wrong-token', 'x-project-id': PROJECT_A.id },
      });
      expect(res.status).toBe(401);
    });

    it('rejects a valid-looking token for an unknown project id with 401', async () => {
      const res = await app.request('/threads', {
        headers: { authorization: `Bearer ${PROJECT_A.token}`, 'x-project-id': 'ghost-project' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('body project_id must match the authenticated project (403)', () => {
    const threadBody = (projectId: string): string =>
      JSON.stringify({
        project_id: projectId,
        mailbox_address: 'jan@acme.com',
        root_message_id: '<m1@host>',
        subject: 'Hello',
        snippet: 'hello there',
        sender: 'Petr <petr@acme.com>',
      });

    it('returns 403 when the payload claims a different project', async () => {
      const res = await app.request('/threads', {
        method: 'POST',
        headers: authHeaders(PROJECT_A),
        body: threadBody('some-other-project'),
      });
      expect(res.status).toBe(403);
    });

    it('returns 200 when the payload project_id matches the token', async () => {
      const res = await app.request('/threads', {
        method: 'POST',
        headers: authHeaders(PROJECT_A),
        body: threadBody(PROJECT_A.id),
      });
      expect(res.status).toBe(200);
    });
  });
});
