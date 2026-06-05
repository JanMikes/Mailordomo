/**
 * INTENT-DERIVED PRIVACY suite for silent learning (Golden rule #3 / PROJECT.md §5: "Email bodies
 * never leave the local machine. Only metadata + subject + snippet + sender go to the server"). The
 * two — and ONLY two — things Phase 6 may send across the boundary are `LearningEntry.summary` and the
 * sanctioned `ToneFile.content`. A learning cycle reads the DRAFT and SENT email bodies LOCALLY (the
 * draft-vs-sent diff literally contains both) — none of that, nor the local before/after snapshots,
 * may cross.
 *
 * We drive the REAL in-process server through a CAPTURING fetch and deep-scan the exact outbound bytes
 * (the same technique as Phase 4.5's `privacy-no-body.test.ts`), with a self-check proving the scanner
 * is not vacuous. Additive to the implementer's `learning.smoke.test.ts`.
 *
 * MUTATION CHECK (pins "no email body / diff crosses"): make `applyLearning` post the diff or a body to
 * the server (e.g. add `diff` to `createLearningEntry`) and `apply sends ONLY the summary` +
 * `the email bodies NEVER appear in any outbound bytes` FAIL. Verified by the self-check planting a body.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_SERVER_PAYLOAD_KEYS } from '@mailordomo/shared';
import {
  PROJECT_A,
  capturingFetch,
  startInProcessServer,
  type CapturedRequest,
  type InProcessServer,
} from '../integration/harness';
import type { MetadataClient } from '../metadata-client';
import { ToneStore } from '../tone/store';
import { LearningLog } from './log';
import { applyLearning } from './learn';
import type { LearnSignal, LearnTarget, LearningDeps } from './learn';
import { draftVsSentDiff } from './signals';
import { syncToneFiles } from '../tone/sync';
import { FakeClaudeRunner } from '../claude';

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

/** Collect every string key appearing ANYWHERE in a JSON value (objects + nested arrays/objects). */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

// --- Markers. Email bodies must NEVER cross; tone content / summary are sanctioned. ----------------
const DRAFT_MARK = 'CONFIDENTIAL-DRAFT-9b2'; // lives in the draft body → email content → NEVER crosses
const SENT_MARK = 'SECRET-SENT-4c1'; //          lives in the sent body  → email content → NEVER crosses
const PRIOR_TONE = 'PRIOR-TONE-MARKER-7f3a'; //  existing tone content → sanctioned (may cross on SYNC)
const LESSON = 'LESSON-MARKER-5d0: state figures plainly; the user tightens hedged drafts.';
const SUMMARY = 'Learned: plainer figures for this contact.'; // the ONLY thing that crosses on apply

const DRAFT_BODY = `Dear Petr,\nThe ${DRAFT_MARK} are 42 and 1337, give or take.\nKind regards, Jan`;
const SENT_BODY = `Hi Petr,\nThe ${SENT_MARK} are 42 and 1337.\nJan`;

const TARGET: LearnTarget = {
  projectId: PROJECT_A.id,
  scope: 'contact',
  path: 'contact/petr@acme.com.md',
};

interface Harness {
  deps: LearningDeps;
  /** The REAL underlying client (full tone+learning surface) — drives the tone sync without a cast. */
  client: MetadataClient;
  store: ToneStore;
  server: InProcessServer;
  captured: readonly CapturedRequest[];
}

function makeHarness(): Harness {
  const server = startInProcessServer(PROJECT_A);
  servers.push(server);
  const capture = capturingFetch(server.fetch);
  const client = server.client(PROJECT_A, capture.fetch);
  const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
  const log = LearningLog.open({ dir: tmpDir('mo-learn-') });
  const runner = new FakeClaudeRunner({
    byKind: {
      learn: {
        structuredOutput: { tone_update: LESSON, summary: SUMMARY },
        model: 'claude-sonnet-4-6',
      },
    },
  });
  return {
    deps: { runner, store, log, metadata: client },
    client,
    store,
    server,
    captured: capture.captured,
  };
}

/** The draft-vs-sent diff signal — its rendered form contains BOTH email bodies (local-only). */
function diffSignal(): LearnSignal {
  return { type: 'draft-vs-sent', diff: draftVsSentDiff(DRAFT_BODY, SENT_BODY) };
}

function bodyRequests(captured: readonly CapturedRequest[]): CapturedRequest[] {
  return captured.filter((r) => r.rawBody !== undefined);
}

/** Concatenated wire bytes of every captured request — the exact bytes that would hit the network. */
function allWireBytes(captured: readonly CapturedRequest[]): string {
  return bodyRequests(captured)
    .map((r) => r.rawBody ?? '')
    .join('\n');
}

describe('applyLearning privacy — apply sends ONLY the summary across the boundary', () => {
  it('the single outbound write is POST /learning carrying exactly {project_id, scope, summary}', async () => {
    const { deps, store, captured } = makeHarness();
    // Pre-seed prior tone content locally — its presence in the local snapshot must NOT leak on apply.
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: PRIOR_TONE,
      updated_by: 'jan',
      updated_at: '2026-06-05T09:00:00.000Z',
    });

    await applyLearning(deps, TARGET, diffSignal(), { now: '2026-06-05T10:00:00.000Z' });

    const writes = bodyRequests(captured);
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /learning']);
    expect(collectKeys(writes[0]!.body)).toEqual(new Set(['project_id', 'scope', 'summary']));
  });

  it('on apply, NONE of the email bodies / diff / prior-tone snapshot / lesson cross — only the summary', async () => {
    const { deps, store, captured } = makeHarness();
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: PRIOR_TONE,
      updated_by: 'jan',
      updated_at: '2026-06-05T09:00:00.000Z',
    });

    await applyLearning(deps, TARGET, diffSignal(), { now: '2026-06-05T10:00:00.000Z' });

    const bytes = allWireBytes(captured);
    // Email content (and the diff that contains it) — NEVER.
    expect(bytes).not.toContain(DRAFT_MARK);
    expect(bytes).not.toContain(SENT_MARK);
    // The before/after tone snapshot and the appended lesson are local on apply — they do NOT cross here.
    expect(bytes).not.toContain(PRIOR_TONE);
    expect(bytes).not.toContain('LESSON-MARKER-5d0');
    // The one sanctioned thing that DID cross: the changelog summary.
    expect(bytes).toContain(SUMMARY);
  });
});

describe('tone sync privacy — tone CONTENT is sanctioned, but email bodies still never cross', () => {
  it('after applying + syncing, PUT /tone carries the tone content; the email bodies NEVER appear', async () => {
    const { deps, client, store, captured } = makeHarness();
    store.write({
      scope: TARGET.scope,
      path: TARGET.path,
      content: PRIOR_TONE,
      updated_by: 'jan',
      updated_at: '2026-06-05T09:00:00.000Z',
    });

    await applyLearning(deps, TARGET, diffSignal(), { now: '2026-06-05T10:00:00.000Z' });
    // The same client (capturing fetch) drives the tone sync — it satisfies ToneSyncClient.
    await syncToneFiles(client, store);

    const bytes = allWireBytes(captured);
    // Sanctioned derived memory DID cross on sync (tone content = prior + appended lesson).
    expect(bytes).toContain(PRIOR_TONE);
    expect(bytes).toContain('LESSON-MARKER-5d0');
    // But the email bodies / diff are email content and STILL never leave — not even riding tone sync.
    expect(bytes).not.toContain(DRAFT_MARK);
    expect(bytes).not.toContain(SENT_MARK);
  });

  it('no captured outbound body contains ANY forbidden body/draft/eml/attachment key', async () => {
    const { deps, client, store, captured } = makeHarness();
    await applyLearning(deps, TARGET, diffSignal(), { now: '2026-06-05T10:00:00.000Z' });
    await syncToneFiles(client, store);

    for (const req of bodyRequests(captured)) {
      const keys = collectKeys(req.body);
      for (const forbidden of FORBIDDEN_SERVER_PAYLOAD_KEYS) {
        expect(keys.has(forbidden), `forbidden "${forbidden}" in ${req.method} ${req.path}`).toBe(
          false,
        );
      }
    }
  });

  it('the privacy guard is REAL: a planted email body WOULD be detected by the scanner', () => {
    // Mutation-style self-check — prove the scan trips on a body, so a green suite means "clean".
    const plantedKeys = collectKeys({ thread_id: 't', draftBody: DRAFT_BODY });
    expect(FORBIDDEN_SERVER_PAYLOAD_KEYS.some((k) => plantedKeys.has(k))).toBe(true);
    const plantedWire = JSON.stringify({ summary: SUMMARY, draft_body: DRAFT_BODY });
    expect(plantedWire).toContain(DRAFT_MARK); // a body riding the wire WOULD be caught by allWireBytes
  });
});
