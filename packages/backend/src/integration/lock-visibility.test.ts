/**
 * Phase 4.5 · Test 3 — CROSS-INSTANCE LOCK VISIBILITY (DoD b; the Jan/Simona presence primitive).
 *
 * Intent (PLAN.md §7 Phase 4.5 "a lock set on one backend instance is visible to a second instance
 * via the metadata service"; PROJECT.md §6 thread locks prevent Jan/Simona double-handling): two
 * SEPARATE {@link MetadataClient} instances — modeling two backends (Jan's machine and Simona's) —
 * talk to ONE in-process REAL metadata server. A lock that instance A acquires must be visible to
 * instance B (B sees `locked_by` + `expires_at`), B's own acquire must be refused with the current
 * holder for presence, and once A releases, B can acquire. The metadata service is the single
 * arbiter; there is no peer-to-peer state.
 *
 * Both clients use the SAME project (one shared workspace) but DIFFERENT actors — exactly the real
 * Jan/Simona topology. TTL-expiry-via-the-client is addressed at the end (see the note): the
 * in-process server stamps `now` itself (the route calls `nowIso()`), so wall-clock expiry is not
 * deterministically drivable through `app.fetch` without a real sleep — that path is covered
 * deterministically at the server unit level (Phase 2 `locks.test.ts`, injected clock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MetadataClient } from '../metadata-client';
import { MetadataError } from '../metadata-client';
import type { Thread } from '@mailordomo/shared';
import { PROJECT_A, startInProcessServer, type InProcessServer } from './harness';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe('Phase 4.5 cross-instance lock visibility — A locks, B sees it, A releases, B acquires', () => {
  let server: InProcessServer;
  /** Instance A = Jan's backend; instance B = Simona's backend. Same project, different actors. */
  let instanceA: MetadataClient;
  let instanceB: MetadataClient;
  let thread: Thread;

  beforeEach(async () => {
    server = startInProcessServer(PROJECT_A);
    // Two DISTINCT client instances against the one server — the cross-instance topology.
    instanceA = server.client(PROJECT_A);
    instanceB = server.client(PROJECT_A);
    // A thread must exist before it can be locked (locks reference a real thread).
    thread = await instanceA.upsertThread({
      project_id: PROJECT_A.id,
      mailbox_address: 'jan@acme.com',
      root_message_id: '<lock-thread@host>',
      subject: 'Contended thread',
      snippet: 'Who is handling this?',
      sender: 'Petr <petr@acme.com>',
    });
  });

  afterEach(() => {
    server.close();
  });

  it("A acquires; B's acquire is refused with A's lock; B's listLocks() shows A's lock", async () => {
    const a = await instanceA.acquireLock({ thread_id: thread.id, locked_by: 'jan' });
    expect(a.acquired).toBe(true);
    expect(a.lock).toMatchObject({ thread_id: thread.id, locked_by: 'jan' });
    expect(a.lock.locked_at).toMatch(ISO);
    expect(a.lock.expires_at).toMatch(ISO);
    // A real TTL: the lock expires strictly AFTER it was taken (default 30-min TTL on the server).
    expect(Date.parse(a.lock.expires_at)).toBeGreaterThan(Date.parse(a.lock.locked_at));

    // B (a separate instance) tries to take the SAME thread → refused, NOT thrown: contention is an
    // expected outcome the caller inspects. The body carries A's lock so B can render presence.
    const b = await instanceB.acquireLock({ thread_id: thread.id, locked_by: 'simona' });
    expect(b.acquired).toBe(false);
    expect(b.lock.locked_by).toBe('jan'); // B sees who holds it
    expect(b.lock.expires_at).toBe(a.lock.expires_at); // and when it expires

    // B can independently SEE the active lock via the presence list (the cross-instance primitive).
    const seenByB = await instanceB.listLocks();
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]).toEqual(a.lock);
  });

  it('after A releases, B can acquire the thread (the lock changes hands across instances)', async () => {
    await instanceA.acquireLock({ thread_id: thread.id, locked_by: 'jan' });

    const released = await instanceA.releaseLock({ thread_id: thread.id, locked_by: 'jan' });
    expect(released.released).toBe(true);

    // The slot is now free for the other instance.
    const b = await instanceB.acquireLock({ thread_id: thread.id, locked_by: 'simona' });
    expect(b.acquired).toBe(true);
    expect(b.lock.locked_by).toBe('simona');

    // And now A sees Simona holding it — visibility flows the other way too.
    const seenByA = await instanceA.listLocks();
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.locked_by).toBe('simona');
  });

  it("B cannot release A's actively-held lock (released:false), and A keeps it", async () => {
    await instanceA.acquireLock({ thread_id: thread.id, locked_by: 'jan' });

    // A non-holder release is a no-op (not an error): the lock is NOT freed.
    const bRelease = await instanceB.releaseLock({ thread_id: thread.id, locked_by: 'simona' });
    expect(bRelease.released).toBe(false);

    // Proof it's still held by jan: B acquiring is still refused with jan's lock.
    const bAcquire = await instanceB.acquireLock({ thread_id: thread.id, locked_by: 'simona' });
    expect(bAcquire.acquired).toBe(false);
    expect(bAcquire.lock.locked_by).toBe('jan');
  });

  it("B's refresh of A's lock is rejected (a non-holder cannot heartbeat someone else's lock)", async () => {
    await instanceA.acquireLock({ thread_id: thread.id, locked_by: 'jan' });
    // refreshLock surfaces the 409 as a thrown MetadataError (refresh has no allowStatuses).
    await expect(
      instanceB.refreshLock({ thread_id: thread.id, locked_by: 'simona' }),
    ).rejects.toBeInstanceOf(MetadataError);
    await expect(
      instanceB.refreshLock({ thread_id: thread.id, locked_by: 'simona' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('A heartbeat-reacquire extends the same lock; both instances see the later expiry', async () => {
    const first = await instanceA.acquireLock({
      thread_id: thread.id,
      locked_by: 'jan',
      ttl_seconds: 60,
    });
    // The same holder re-acquiring with a longer TTL is a heartbeat: same locked_at, later expiry.
    const beat = await instanceA.acquireLock({
      thread_id: thread.id,
      locked_by: 'jan',
      ttl_seconds: 3600,
    });
    expect(beat.acquired).toBe(true);
    expect(beat.lock.locked_at).toBe(first.lock.locked_at);
    expect(Date.parse(beat.lock.expires_at)).toBeGreaterThan(Date.parse(first.lock.expires_at));

    // The OTHER instance observes the extended expiry — one source of truth, not peer state.
    const seenByB = await instanceB.listLocks();
    expect(seenByB[0]?.expires_at).toBe(beat.lock.expires_at);
  });

  /**
   * TTL-expiry note (PLAN.md §7 Phase 4.5 "timeout releases"): a short-`ttl_seconds` acquire IS
   * accepted by the client→server path, but the holder is still active immediately afterward — the
   * server's wall clock has not advanced — so a CONTENDING acquire is correctly refused here. Driving
   * the lock past `expires_at` would require either a real sleep (forbidden — flaky) or an injectable
   * server clock, which the in-process route does not expose (it calls `nowIso()` internally). Hence
   * timeout-RELEASE is asserted deterministically at the server unit level (Phase 2 `locks.test.ts`:
   * "an EXPIRED lock is acquirable by a different actor", injected `now`). Here we assert that a tiny
   * TTL still yields a live, contended lock — i.e. expiry is NOT instantaneous.
   */
  it('a short ttl_seconds lock is live immediately after acquire (expiry is not instantaneous)', async () => {
    const a = await instanceA.acquireLock({
      thread_id: thread.id,
      locked_by: 'jan',
      ttl_seconds: 1,
    });
    expect(a.acquired).toBe(true);
    expect(Date.parse(a.lock.expires_at)).toBeGreaterThan(Date.parse(a.lock.locked_at));

    // Immediately (same wall-clock instant) a different instance is still refused — the lock has not
    // yet expired on the server. (Deterministic timeout-RELEASE: server unit level, injected clock.)
    const b = await instanceB.acquireLock({ thread_id: thread.id, locked_by: 'simona' });
    expect(b.acquired).toBe(false);
    expect(b.lock.locked_by).toBe('jan');
  });
});
