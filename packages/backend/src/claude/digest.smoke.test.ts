/**
 * Morning-digest SMOKE coverage (PLAN.md D34). Asserts:
 *   - `assembleDigestMetadata` selects each section correctly + is BODY-FREE by construction
 *     (parses the strict shared schema; a planted body never appears);
 *   - the synthesis spec routes to SONNET (Golden rule #6) and is prose (no json-schema);
 *   - `synthesizeDigest` turns the body-free metadata into prose via the fake runner;
 *   - the rendered prompt carries ONLY sanctioned metadata (no message body can leak even though the
 *     synthesis runs locally — Golden rule #3).
 */
import { describe, expect, it } from 'vitest';
import {
  DigestMetadataSchema,
  modelForTask,
  type DigestTransitionEntry,
  type DraftMeta,
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

function thread(id: string, subject: string, over: Partial<Thread> = {}): Thread {
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
    ...over,
  };
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

describe('assembleDigestMetadata (smoke)', () => {
  const threads = [thread('t1', 'Invoice question'), thread('t2', 'Thanks!')];
  const tasks = [
    task('t1', { state: 'needs-reply', importance: 'high', deadline: '2026-06-06T17:00:00.000Z' }),
    task('t2', { state: 'done' }), // excluded from needs_you
  ];
  const promises: PromiseRecord[] = [
    {
      id: 'p1',
      thread_id: 't1',
      direction: 'they-asked',
      text: 'Clarify line 4 of the invoice',
      due_at: '2026-06-05T18:00:00.000Z', // within window end ⇒ due
      due_raw: 'by tomorrow',
      status: 'open',
      actor: 'me',
      created_at: WINDOW.start,
    },
    {
      id: 'p2',
      thread_id: 't1',
      direction: 'my-promise',
      text: 'Send the signed contract',
      due_at: '2026-06-05T10:00:00.000Z',
      due_raw: null,
      status: 'fulfilled', // not actionable ⇒ excluded
      actor: 'me',
      created_at: WINDOW.start,
    },
  ];
  const transitions: DigestTransitionEntry[] = [
    {
      task_id: 'task-t2',
      thread_id: 't2',
      subject: 'Thanks!',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona', // the "what Simona handled" attribution
      at: '2026-06-05T12:00:00.000Z',
    },
    {
      task_id: 'task-old',
      thread_id: 't9',
      subject: 'Old',
      from: 'needs-reply',
      to: 'done',
      actor: 'simona',
      at: '2026-05-01T12:00:00.000Z', // out of window ⇒ excluded
    },
  ];
  const draftMeta: DraftMeta[] = [
    {
      id: 'd1',
      thread_id: 't1',
      version: 1,
      model: 'opus',
      author: 'claude',
      at: '2026-06-05T13:00:00.000Z',
    },
    {
      id: 'd2',
      thread_id: 't1',
      version: 1,
      model: 'opus',
      author: 'claude',
      at: '2026-05-01T13:00:00.000Z',
    }, // out of window
  ];

  const metadata = assembleDigestMetadata(
    { projectId: 'proj-1', tasks, threads, promises, draftMeta, transitions, generatedAtIso: NOW },
    WINDOW,
  );

  it('parses the STRICT shared DigestMetadata schema (body-free by construction)', () => {
    expect(() => DigestMetadataSchema.parse(metadata)).not.toThrow();
  });

  it('needs_you = tasks needing my action joined to their thread (excludes done)', () => {
    expect(metadata.needs_you.map((r) => r.thread_id)).toEqual(['t1']);
    expect(metadata.needs_you[0]).toMatchObject({
      subject: 'Invoice question',
      sender: 'Lumír <lumir@acme.com>',
      state: 'needs-reply',
      importance: 'high',
      deadline: '2026-06-06T17:00:00.000Z',
    });
  });

  it('promises_due = actionable promises with a deadline at/before the window end', () => {
    expect(metadata.promises_due.map((p) => p.promise_id)).toEqual(['p1']); // p2 fulfilled ⇒ out
    expect(metadata.promises_due[0]).toMatchObject({ subject: 'Invoice question', status: 'open' });
  });

  it('handled = actor-attributed transitions WITHIN the window only', () => {
    expect(metadata.handled.map((h) => h.task_id)).toEqual(['task-t2']); // out-of-window dropped
    expect(metadata.handled[0]?.actor).toBe('simona');
  });

  it('drafted = draft metadata within the window only', () => {
    expect(metadata.drafted.map((d) => d.at)).toEqual(['2026-06-05T13:00:00.000Z']);
  });

  it('is BODY-FREE: no body-ish key appears anywhere in the serialized metadata', () => {
    const json = JSON.stringify(metadata);
    expect(json).not.toMatch(/"body"|"html"|"text_body"|"raw"/);
  });
});

describe('digest synthesis routing + privacy (smoke)', () => {
  const metadata = assembleDigestMetadata(
    { projectId: 'proj-1', tasks: [], threads: [], promises: [], draftMeta: [], transitions: [] },
    WINDOW,
  );

  it('routes to SONNET and is prose (no json-schema) using digest.md', () => {
    expect(modelForTask('digest')).toBe('sonnet');
    const spec = buildDigestSpec(metadata);
    expect(spec.taskKind).toBe('digest');
    expect(spec.jsonSchema).toBeUndefined();
    expect(spec.systemPromptFile).toMatch(/digest\.md$/);
  });

  it('synthesizes prose locally via the runner', async () => {
    const runner = new FakeClaudeRunner({
      byKind: { digest: { text: 'Good morning — 2 things need you.' } },
    });
    const result = await synthesizeDigest(runner, metadata);
    expect(result.prose).toBe('Good morning — 2 things need you.');
    expect(result.model).toBe('sonnet'); // the fake echoes the routed alias
  });

  it('the rendered prompt carries only sanctioned metadata (no body could leak)', () => {
    const withData = assembleDigestMetadata(
      {
        projectId: 'proj-1',
        tasks: [task('t1', { state: 'needs-reply' })],
        threads: [thread('t1', 'Invoice question')],
        promises: [],
        draftMeta: [],
        transitions: [
          {
            task_id: 'x',
            thread_id: 't1',
            subject: 'Invoice question',
            from: 'needs-reply',
            to: 'done',
            actor: 'simona',
            at: '2026-06-05T12:00:00.000Z',
          },
        ],
      },
      WINDOW,
    );
    const prompt = renderDigestPrompt(withData);
    // Only subjects/senders/actors/states appear — never a message body (there is none to leak).
    expect(prompt).toContain('Invoice question');
    expect(prompt).toContain('simona moved');
    expect(prompt).not.toMatch(/\bbody\b/i);
  });
});
