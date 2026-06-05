/**
 * INTENT-DERIVED suite for tone-file LAST-WRITE-WINS sync (PROJECT.md §3 + Golden rule #2: "Tone-memory
 * markdown syncs via the server as arbiter, last-write-wins per file … If we ever find ourselves
 * writing merge/reconciliation logic between two writable stores, we have taken a wrong turn"). Written
 * from the SPEC's sync invariant, NOT from the impl — additive to the implementer's `tone.smoke.test.ts`.
 *
 * Load-bearing invariants pinned here:
 *  - LWW DIRECTION: newer `updated_at` wins; on a tie, the STRICTLY-GREATER `version_hash` wins;
 *    identical ⇒ noop; an absent side always loses. (`decideLww`, pure.)
 *  - WHOLE-FILE replacement, NEVER a field merge: after convergence both sides hold ONE side's EXACT
 *    bytes; the loser's distinctive lines are GONE (not spliced in).
 *  - CROSS-MACHINE CONVERGENCE: two local stores syncing through the in-process server arbiter end up
 *    byte-identical to the authoritative file.
 *  - `version_hash` is a deterministic CONTENT hash: identical content ⇒ identical hash (re-push is a
 *    true no-op); different content ⇒ different hash (so the tie-break is meaningful).
 *
 * MUTATION CHECK (pins "LWW tie-break DIRECTION + no-merge"): flip the tie-break in `decideLww`/the
 * server's `toneWriteWins` to strictly-LESSER hash and the `converges to the GREATER-hash file on an
 * updated_at tie` test converges to the other content and FAILS. Replace `store.adopt` with any
 * field-splicing merge and `the loser's unique line is gone` FAILS. Verified by reasoning.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { decideLww } from './lww';
import type { LwwSide } from './lww';
import { ToneStore, toneVersionHash } from './store';
import { syncToneFiles } from './sync';

const tmpDirs: string[] = [];
const servers: InProcessServer[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T_OLD = '2026-06-05T10:00:00.000Z';
const T_NEW = '2026-06-05T11:00:00.000Z';

describe('decideLww — the pure push/pull/noop rule (PROJECT.md §3, Golden rule #2)', () => {
  it('a present side always beats an absent side; both absent ⇒ noop', () => {
    const side: LwwSide = { version_hash: 'h', updated_at: T_OLD };
    expect(decideLww(undefined, undefined)).toBe('noop');
    expect(decideLww(side, undefined)).toBe('push'); // only local has it → push
    expect(decideLww(undefined, side)).toBe('pull'); // only server has it → pull
  });

  it('newer updated_at wins, in BOTH directions', () => {
    const older: LwwSide = { version_hash: 'h', updated_at: T_OLD };
    const newer: LwwSide = { version_hash: 'h', updated_at: T_NEW };
    expect(decideLww(newer, older)).toBe('push'); // local newer
    expect(decideLww(older, newer)).toBe('pull'); // server newer
  });

  it('on an updated_at TIE, the STRICTLY-GREATER version_hash string wins (and equal ⇒ noop)', () => {
    const lo: LwwSide = { version_hash: 'aaa', updated_at: T_OLD };
    const hi: LwwSide = { version_hash: 'zzz', updated_at: T_OLD };
    expect(decideLww(hi, lo)).toBe('push'); // local hash strictly greater → push
    expect(decideLww(lo, hi)).toBe('pull'); // server hash strictly greater → pull
    expect(decideLww(lo, { ...lo })).toBe('noop'); // identical updated_at AND hash → noop
  });

  it('an unparseable updated_at is treated as the oldest (never silently wins)', () => {
    const good: LwwSide = { version_hash: 'h', updated_at: T_OLD };
    const bad: LwwSide = { version_hash: 'h', updated_at: 'not-a-date' };
    expect(decideLww(bad, good)).toBe('pull'); // server's real date beats the local junk
    expect(decideLww(good, bad)).toBe('push'); // local's real date beats the server junk
  });
});

describe('toneVersionHash — deterministic CONTENT hash (makes the tie-break meaningful)', () => {
  it('identical content ⇒ identical hash (a re-push of the same content is a true no-op)', () => {
    expect(toneVersionHash('Prefer short sign-offs.')).toBe(
      toneVersionHash('Prefer short sign-offs.'),
    );
  });

  it('different content ⇒ different hash (so an updated_at tie has a real winner to pick)', () => {
    expect(toneVersionHash('voice A')).not.toBe(toneVersionHash('voice B'));
  });
});

describe('cross-machine convergence through the REAL in-process server (whole-file, no merge)', () => {
  const REL = 'contact/jan@acme.com.md';

  /** Two fresh local stores ("two machines") that sync against the SAME in-process server. */
  function twoMachines(): { server: InProcessServer; a: ToneStore; b: ToneStore } {
    const server = startInProcessServer(PROJECT_A);
    servers.push(server);
    const a = ToneStore.open({ dir: tmpDir('mo-lww-a-'), projectId: PROJECT_A.id });
    const b = ToneStore.open({ dir: tmpDir('mo-lww-b-'), projectId: PROJECT_A.id });
    return { server, a, b };
  }

  it('the NEWER updated_at wins and BOTH machines converge to its EXACT bytes (loser lines gone)', async () => {
    const { server, a, b } = twoMachines();
    const client = server.client(PROJECT_A);

    const older = 'OLD-LINE-1\nshared\nOLD-LINE-3';
    const newer = 'NEW-LINE-1\nshared\nNEW-LINE-3';
    a.write({ scope: 'contact', path: REL, content: older, updated_by: 'jan', updated_at: T_OLD });
    b.write({
      scope: 'contact',
      path: REL,
      content: newer,
      updated_by: 'simona',
      updated_at: T_NEW,
    });

    // Sync A (server adopts A's older file), then B (B's newer file wins), then A again (A pulls newer).
    await syncToneFiles(client, a);
    await syncToneFiles(client, b);
    await syncToneFiles(client, a);

    // Converged: both stores hold the NEWER file's EXACT content, with the SAME content hash.
    expect(a.read(REL)?.content).toBe(newer);
    expect(b.read(REL)?.content).toBe(newer);
    expect(a.read(REL)?.version_hash).toBe(toneVersionHash(newer));
    expect(b.read(REL)?.version_hash).toBe(toneVersionHash(newer));
    // NO field-merge: the loser's distinctive lines are absent from BOTH machines (not spliced in).
    expect(a.read(REL)?.content).not.toContain('OLD-LINE-1');
    expect(b.read(REL)?.content).not.toContain('OLD-LINE-3');
  });

  it('on an updated_at TIE, both machines converge to the GREATER-hash file (pins tie DIRECTION)', async () => {
    const { server, a, b } = twoMachines();
    const client = server.client(PROJECT_A);

    const x = 'TIE-CONTENT-X\nbody x';
    const y = 'TIE-CONTENT-Y\nbody y';
    // SAME updated_at on both sides → a true tie; the winner is decided purely by the hash compare.
    const sameAt = T_OLD;
    a.write({ scope: 'contact', path: REL, content: x, updated_by: 'jan', updated_at: sameAt });
    b.write({ scope: 'contact', path: REL, content: y, updated_by: 'simona', updated_at: sameAt });

    // The SPEC rule is "strictly-greater version_hash wins" — compute the expected winner independently.
    const expectedWinner = toneVersionHash(x) > toneVersionHash(y) ? x : y;

    await syncToneFiles(client, a);
    await syncToneFiles(client, b);
    await syncToneFiles(client, a);
    await syncToneFiles(client, b);

    expect(a.read(REL)?.content).toBe(expectedWinner);
    expect(b.read(REL)?.content).toBe(expectedWinner);
    // If the tie-break used the LESSER hash, both would converge to the other content and this fails.
  });

  it('a file that exists only on the OTHER machine is pulled down wholesale', async () => {
    const { server, a, b } = twoMachines();
    const client = server.client(PROJECT_A);

    a.write({
      scope: 'project',
      path: 'project/tone.md',
      content: 'project-only voice',
      updated_by: 'jan',
      updated_at: T_OLD,
    });
    await syncToneFiles(client, a); // push A's project file to the server

    // B has never seen it; a sync pulls it down byte-identical.
    const report = await syncToneFiles(client, b);
    expect(report.pulled).toContain('project/tone.md');
    expect(b.read('project/tone.md')?.content).toBe('project-only voice');
    expect(b.read('project/tone.md')?.version_hash).toBe(toneVersionHash('project-only voice'));
  });

  it('is idempotent at a fixed point: a second sync with no edits is all-noop and changes nothing', async () => {
    const { server, a } = twoMachines();
    const client = server.client(PROJECT_A);
    a.write({
      scope: 'contact',
      path: REL,
      content: 'stable',
      updated_by: 'jan',
      updated_at: T_OLD,
    });

    await syncToneFiles(client, a);
    const hashAfterFirst = a.read(REL)?.version_hash;

    const second = await syncToneFiles(client, a);
    // Nothing new pushed or pulled; the local file is byte-stable.
    expect(second.pushed).toEqual([]);
    expect(a.read(REL)?.content).toBe('stable');
    expect(a.read(REL)?.version_hash).toBe(hashAfterFirst);
  });
});
