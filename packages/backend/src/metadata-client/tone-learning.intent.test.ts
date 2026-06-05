/**
 * INTENT-DERIVED round-trip suite for the MetadataClient's Phase-6 tone/learning surface, exercised
 * against the REAL in-process Hono server (NOT a stub) via the established `app.fetch` seam (PLAN.md
 * §7 Phase 6 / §4.4). Additive to `client.smoke.test.ts`. Proves the wire contract the tone-sync and
 * silent-learning orchestrators depend on:
 *  - `putToneFile` accepts a first write AND, on an LWW-LOSING push, returns the AUTHORITATIVE file
 *    (server arbitrates; the client adopts whatever comes back — Golden rule #2, never a merge).
 *  - `listToneFiles` returns the project's files.
 *  - `createLearningEntry` records summary-only and assigns `id`/`applied_at`; `listLearningEntries`
 *    reads the changelog; `revertLearningEntry` sets `reverted_at` and is idempotent.
 *
 * MUTATION CHECK (pins "LWW push returns the authoritative loser-adopts-winner file"): flip the
 * server's `toneWriteWins` and `a stale push is REJECTED and returns the newer authoritative file`
 * FAILS (it would accept the stale write). Verified by reasoning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PutToneFileRequest } from '@mailordomo/shared';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { toneVersionHash } from '../tone/store';

const servers: InProcessServer[] = [];

afterEach(() => {
  // Closes the underlying repo (repo.close()) for each in-process server.
  for (const server of servers.splice(0)) server.close();
});

function freshServer(): InProcessServer {
  const server = startInProcessServer(PROJECT_A);
  servers.push(server);
  return server;
}

function toneReq(
  patchPath: string,
  content: string,
  updated_at: string,
  updated_by = 'jan',
): PutToneFileRequest {
  return {
    project_id: PROJECT_A.id,
    scope: 'contact',
    path: patchPath,
    content,
    version_hash: toneVersionHash(content),
    updated_by,
    updated_at,
  };
}

const T_OLD = '2026-06-05T10:00:00.000Z';
const T_NEW = '2026-06-05T11:00:00.000Z';

describe('MetadataClient.putToneFile / listToneFiles — LWW round-trips against the REAL server', () => {
  it('accepts a first write and echoes it back as the authoritative file', async () => {
    const client = freshServer().client(PROJECT_A);
    const res = await client.putToneFile(toneReq('contact/a.md', 'voice A', T_OLD));
    expect(res.accepted).toBe(true);
    expect(res.file.content).toBe('voice A');
    expect(res.file.version_hash).toBe(toneVersionHash('voice A'));
  });

  it('a stale push is REJECTED and returns the NEWER authoritative file (loser adopts winner)', async () => {
    const client = freshServer().client(PROJECT_A);
    // The server already holds a NEWER version.
    await client.putToneFile(toneReq('contact/a.md', 'newer voice', T_NEW));

    // A push with an OLDER updated_at must lose; the response is the authoritative newer file.
    const res = await client.putToneFile(toneReq('contact/a.md', 'stale voice', T_OLD));
    expect(res.accepted).toBe(false);
    expect(res.file.content).toBe('newer voice');
    expect(res.file.version_hash).toBe(toneVersionHash('newer voice'));
  });

  it('lists every tone file the project holds', async () => {
    const client = freshServer().client(PROJECT_A);
    await client.putToneFile(toneReq('contact/a.md', 'A', T_OLD));
    await client.putToneFile(toneReq('contact/b.md', 'B', T_OLD));
    const files = await client.listToneFiles();
    expect(files.map((f) => f.path).sort()).toEqual(['contact/a.md', 'contact/b.md']);
  });
});

describe('MetadataClient learning changelog — create / list / revert round-trips', () => {
  it('records a summary-only entry, assigns id/applied_at, and lists it', async () => {
    const client = freshServer().client(PROJECT_A);
    const created = await client.createLearningEntry({
      project_id: PROJECT_A.id,
      scope: 'contact',
      summary: 'Learned: shorter sign-offs.',
    });
    expect(created.id).toBeTruthy();
    expect(created.applied_at).toBeTruthy();
    expect(created.reverted_at).toBeNull();
    expect(created.summary).toBe('Learned: shorter sign-offs.');

    const list = await client.listLearningEntries();
    expect(list.map((e) => e.summary)).toEqual(['Learned: shorter sign-offs.']);
  });

  it('reverts an entry (sets reverted_at) and is idempotent on a second revert', async () => {
    const client = freshServer().client(PROJECT_A);
    const created = await client.createLearningEntry({
      project_id: PROJECT_A.id,
      scope: 'mailbox',
      summary: 'Learned: lead with the ask.',
    });

    const reverted = await client.revertLearningEntry(created.id);
    expect(reverted.id).toBe(created.id);
    expect(reverted.reverted_at).not.toBeNull();

    // Idempotent: re-reverting keeps the SAME reverted_at (the server does not re-stamp).
    const again = await client.revertLearningEntry(created.id);
    expect(again.reverted_at).toBe(reverted.reverted_at);
  });
});
