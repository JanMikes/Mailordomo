/**
 * Morning-digest INTENT coverage (separate test-author, fresh context — PLAN.md §4.4). Expected
 * behavior is derived from PROJECT.md §5/§9 + Golden rules #3 (body-free; "what Simona handled" from
 * actor-attributed transitions only) and #6 (digest = Sonnet) FIRST, then asserted:
 *
 *   - BODY-FREE BY CONSTRUCTION: `assembleDigestMetadata` produces no `body`-ish field even when the
 *     source threads/transitions carry one (we PLANT a body on the inputs and prove the strict shared
 *     schema parses AND that the body never reaches the serialized output or the synthesis prompt).
 *   - "handled" = ONLY the actor-attributed transitions passed in, never thread bodies; out-of-window
 *     and any extraneous body fields are excluded.
 *   - #6: the synthesis job routes to SONNET and is prose (no `--json-schema`).
 *
 * Pure assembler ⇒ no IO; the endpoint-level capturing-fetch proof lives in the integration suite.
 * ADDITIVE to `digest.smoke.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  DigestMetadataSchema,
  modelForTask,
  type DigestTransitionEntry,
  type PromiseRecord,
  type Task,
  type Thread,
} from '@mailordomo/shared';
import { FakeClaudeRunner } from './fake-runner';
import {
  assembleDigestMetadata,
  buildDigestSpec,
  renderDigestPrompt,
  synthesizeDigest,
} from './digest';

const WINDOW = { start: '2026-06-05T00:00:00.000Z', end: '2026-06-06T00:00:00.000Z' };
const NOW = '2026-06-06T00:00:00.000Z';

/** A scan for any body-ish key OR the planted secret text anywhere in a serialized blob. */
const BODY_KEY = /"body"|"html"|"text_body"|"raw"|"draftBody"/;
const PLANTED_SECRET = 'TOP-SECRET-EMAIL-BODY-DO-NOT-LEAK';

/**
 * A thread carrying a SMUGGLED body field (typed loosely so we can prove the assembler ignores it). The
 * sanctioned subject/snippet/sender pass through; the `body` must NEVER appear downstream.
 */
function threadWithBody(id: string, subject: string): Thread {
  return {
    id,
    project_id: 'proj-1',
    mailbox_address: 'jan@acme.com',
    root_message_id: `<${id}@host>`,
    subject,
    snippet: `${subject} snippet`,
    sender: 'Lumír <lumir@acme.com>',
    last_message_at: NOW,
    updated_at: NOW,
    // Smuggled — not part of the sanctioned fields the assembler reads.
    body: PLANTED_SECRET,
  } as unknown as Thread;
}

function task(threadId: string, over: Partial<Task> = {}): Task {
  return {
    id: `task-${threadId}`,
    thread_id: threadId,
    state: 'needs-reply',
    deadline: null,
    follow_up_at: null,
    importance: 'normal',
    updated_at: NOW,
    ...over,
  };
}

describe('assembleDigestMetadata — body-free by construction (Golden rule #3, intent)', () => {
  // Threads (and a transition) that ALL carry a planted body; the assembler must strip every one.
  const threads = [threadWithBody('t1', 'Invoice question'), threadWithBody('t2', 'Thanks!')];
  const tasks = [
    task('t1', { state: 'needs-reply', importance: 'high' }),
    task('t2', { state: 'done' }),
  ];
  const promises: PromiseRecord[] = [
    {
      id: 'p1',
      thread_id: 't1',
      direction: 'they-asked',
      text: 'Clarify line 4',
      due_at: '2026-06-05T18:00:00.000Z',
      due_raw: 'by tomorrow',
      status: 'open',
      actor: 'me',
      created_at: WINDOW.start,
    },
  ];
  // A transition object with a smuggled body too — only the sanctioned fields may survive.
  const transitions = [
    {
      task_id: 'task-t2',
      thread_id: 't2',
      subject: 'Thanks!',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona',
      at: '2026-06-05T12:00:00.000Z',
      body: PLANTED_SECRET,
    } as unknown as DigestTransitionEntry,
  ];

  const metadata = assembleDigestMetadata(
    {
      projectId: 'proj-1',
      tasks,
      threads,
      promises,
      draftMeta: [],
      transitions,
      generatedAtIso: NOW,
    },
    WINDOW,
  );

  it('still parses the STRICT shared schema (the smuggled body cannot ride along)', () => {
    // If the assembler ever copied the extra `body` key, strict zod would REJECT it here.
    expect(() => DigestMetadataSchema.parse(metadata)).not.toThrow();
  });

  it('no body key NOR the planted secret appears anywhere in the serialized metadata', () => {
    const json = JSON.stringify(metadata);
    expect(json).not.toMatch(BODY_KEY);
    expect(json).not.toContain(PLANTED_SECRET);
  });

  it('the sanctioned subject DID survive (we stripped the body, not the metadata)', () => {
    // Proves the previous assertion is meaningful: real metadata flows; only the body is gone.
    expect(metadata.needs_you.map((r) => r.subject)).toEqual(['Invoice question']);
    expect(metadata.handled.map((h) => h.subject)).toEqual(['Thanks!']);
  });

  it('the rendered synthesis prompt carries the subject but NEVER the planted body', () => {
    const prompt = renderDigestPrompt(metadata);
    expect(prompt).toContain('Invoice question');
    expect(prompt).toContain('simona moved');
    expect(prompt).not.toContain(PLANTED_SECRET);
    expect(prompt).not.toMatch(/\bbody\b/i);
  });
});

describe('assembleDigestMetadata — "handled" is transitions-only (Golden rule #3, intent)', () => {
  it('contains exactly the in-window actor-attributed transitions passed in — never a thread body', () => {
    const inWindow: DigestTransitionEntry = {
      task_id: 'tk-in',
      thread_id: 't1',
      subject: 'Cleared',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona',
      at: '2026-06-05T10:00:00.000Z',
    };
    const outOfWindow: DigestTransitionEntry = {
      task_id: 'tk-out',
      thread_id: 't9',
      subject: 'Old',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona',
      at: '2026-05-01T10:00:00.000Z', // before the window ⇒ excluded
    };
    const metadata = assembleDigestMetadata(
      {
        projectId: 'proj-1',
        // Threads with bodies exist, but `handled` is built from the TRANSITIONS list, not threads.
        threads: [threadWithBody('t1', 'Cleared')],
        tasks: [],
        promises: [],
        draftMeta: [],
        transitions: [inWindow, outOfWindow],
      },
      WINDOW,
    );

    expect(metadata.handled.map((h) => h.task_id)).toEqual(['tk-in']);
    expect(metadata.handled[0]?.actor).toBe('simona');
    // The thread's body never bleeds into the handled feed.
    expect(JSON.stringify(metadata.handled)).not.toContain(PLANTED_SECRET);
  });
});

describe('digest synthesis routing (Golden rule #6, intent)', () => {
  const empty = assembleDigestMetadata(
    { projectId: 'proj-1', tasks: [], threads: [], promises: [], draftMeta: [], transitions: [] },
    WINDOW,
  );

  it('routes to SONNET and is prose (no json-schema), using digest.md', () => {
    expect(modelForTask('digest')).toBe('sonnet');
    const spec = buildDigestSpec(empty);
    expect(spec.taskKind).toBe('digest');
    expect(spec.jsonSchema).toBeUndefined();
    expect(spec.systemPromptFile).toMatch(/digest\.md$/);
  });

  it('synthesizeDigest runs the SONNET-routed job locally and returns its prose', async () => {
    const runner = new FakeClaudeRunner({ byKind: { digest: { text: 'Good morning.' } } });
    const result = await synthesizeDigest(runner, empty);
    expect(result.prose).toBe('Good morning.');
    expect(result.model).toBe('sonnet'); // the fake echoes the routed alias — proves routing held
    // Exactly one job, and it was the digest (Sonnet), not an outgoing-text model.
    expect(runner.calls.map((c) => c.taskKind)).toEqual(['digest']);
  });
});
