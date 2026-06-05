/**
 * Phase 4.5 · Test 1 — METADATA ROUND-TRIP VIA THE REAL CLIENT (not the fake).
 *
 * Intent (PLAN.md §7 Phase 4.5 "metadata round-trip across the real client"; DoD): prove the local
 * backend's REAL {@link MetadataClient} wires end-to-end against the REAL metadata server across the
 * privacy boundary — pairing/auth, thread + task create→read-back, and project SCOPING (one
 * project's client cannot see another's rows). This is the first time real data flows across the
 * backend↔server boundary, so it must use the real client over the real request/response path, not a
 * stub. Responses are asserted to be the VALIDATED shared DTO shapes (the client `parse()`s every
 * body through the shared zod schema; a contract drift would throw `MetadataValidationError`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MetadataClient } from '../metadata-client';
import { MetadataAuthError } from '../metadata-client';
import { PROJECT_A, PROJECT_B, startInProcessServer, type InProcessServer } from './harness';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe('Phase 4.5 metadata round-trip — REAL client against the in-process REAL server', () => {
  let server: InProcessServer;
  let client: MetadataClient;

  beforeEach(() => {
    server = startInProcessServer(PROJECT_A, PROJECT_B);
    client = server.client(PROJECT_A);
  });

  afterEach(() => {
    server.close();
  });

  /* -------------------------------- pairing / auth -------------------------------- */

  it('pair() succeeds with the seeded token and returns the authed project (identity only)', async () => {
    const project = await client.pair();
    expect(project).toEqual({ id: PROJECT_A.id, name: PROJECT_A.name });
    // The token hash must NEVER be echoed back (Golden rule #4): the validated DTO omits it.
    expect(project).not.toHaveProperty('token_hash');
  });

  it('pair() FAILS with a MetadataAuthError (401) when the token is wrong', async () => {
    const badClient = server.client({ ...PROJECT_A, token: 'not-the-real-token' });
    await expect(badClient.pair()).rejects.toBeInstanceOf(MetadataAuthError);
    await expect(badClient.pair()).rejects.toMatchObject({ status: 401 });
  });

  it('pair() FAILS with a 401 when the project id is unknown', async () => {
    const ghost = server.client({ id: 'no-such-project', name: 'Ghost', token: 'whatever' });
    await expect(ghost.pair()).rejects.toBeInstanceOf(MetadataAuthError);
  });

  /* ----------------------------- thread round-trip ----------------------------- */

  it('upsertThread() → listThreads()/getThread() returns it as a validated Thread DTO', async () => {
    const created = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<thread-rt@host>',
      subject: 'Invoice question',
      snippet: 'Could you clarify line 4?',
      sender: 'Lumír <lumir@acme.com>',
      last_message_at: null,
    });

    // Server-assigned identity + the sanctioned shared fields survived the round-trip.
    expect(typeof created.id).toBe('string');
    expect(created).toMatchObject({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<thread-rt@host>',
      subject: 'Invoice question',
      snippet: 'Could you clarify line 4?',
      sender: 'Lumír <lumir@acme.com>',
      last_message_at: null,
    });
    // The parsed DTO carries `updated_at` (an ISO instant) — proof it matched ThreadSchema, not a
    // looser shape: the client would have thrown MetadataValidationError otherwise.
    expect(created.updated_at).toMatch(ISO);

    const listed = await client.listThreads();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);

    const fetched = await client.getThread(created.id);
    expect(fetched).toEqual(created);
  });

  it('upsertThread() is an UPSERT by root message id (no duplicate row)', async () => {
    const base = {
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<dedup@host>',
      sender: 'Petr <petr@acme.com>',
    } as const;
    await client.upsertThread({ ...base, subject: 'First', snippet: 'first snippet' });
    const second = await client.upsertThread({
      ...base,
      subject: 'Updated',
      snippet: 'updated snippet',
    });

    const listed = await client.listThreads();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.subject).toBe('Updated');
    expect(listed[0]?.id).toBe(second.id);
  });

  /* ------------------------------ task round-trip ------------------------------ */

  it('createTask() → listTasks(threadId) returns it as a validated Task DTO with defaults', async () => {
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<task-rt@host>',
      subject: 'Quarterly report',
      snippet: 'Please send the report',
      sender: 'Petr <petr@acme.com>',
    });

    const task = await client.createTask({
      thread_id: thread.id,
      state: 'needs-reply',
      importance: 'high',
      deadline: '2026-07-01T09:00:00.000Z',
    });
    expect(task).toMatchObject({
      thread_id: thread.id,
      state: 'needs-reply',
      importance: 'high',
      deadline: '2026-07-01T09:00:00.000Z',
      follow_up_at: null,
    });
    expect(task.updated_at).toMatch(ISO);

    const tasksForThread = await client.listTasks(thread.id);
    expect(tasksForThread).toEqual([task]);

    // The unfiltered list returns it too.
    const allTasks = await client.listTasks();
    expect(allTasks).toContainEqual(task);
  });

  it('createTask() applies the server defaults when state/importance are omitted', async () => {
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<task-defaults@host>',
      subject: 'Defaults',
      snippet: 'snippet',
      sender: 'Petr <petr@acme.com>',
    });
    const task = await client.createTask({ thread_id: thread.id });
    // Server-side defaults (PROJECT.md §6 initial state; importance 'normal').
    expect(task.state).toBe('needs-reply');
    expect(task.importance).toBe('normal');
    expect(task.deadline).toBeNull();
  });

  /* ---------------------------------- scoping ---------------------------------- */

  it("a second project's client cannot see the first's threads (project scoping)", async () => {
    const created = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<scoped@host>',
      subject: 'Project A only',
      snippet: 'secret to A',
      sender: 'Petr <petr@acme.com>',
    });

    const clientB = server.client(PROJECT_B);
    // B authenticates fine against its own project...
    await expect(clientB.pair()).resolves.toMatchObject({ id: PROJECT_B.id });
    // ...but A's rows are invisible to B.
    expect(await clientB.listThreads()).toEqual([]);
    // Fetching A's thread by id as B is a 404 (not a leak).
    await expect(clientB.getThread(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a second project's client cannot see the first's tasks (project scoping)", async () => {
    const thread = await client.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<scoped-task@host>',
      subject: 'A task thread',
      snippet: 'snippet',
      sender: 'Petr <petr@acme.com>',
    });
    await client.createTask({ thread_id: thread.id, state: 'needs-reply' });

    const clientB = server.client(PROJECT_B);
    // B sees no tasks at all, and filtering by A's thread id yields nothing.
    expect(await clientB.listTasks()).toEqual([]);
    expect(await clientB.listTasks(thread.id)).toEqual([]);
  });
});
