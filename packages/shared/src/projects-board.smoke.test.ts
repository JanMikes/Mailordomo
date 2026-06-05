/**
 * SMOKE — the Phase 7c (D32) shared contract additions: the body-free {@link ProjectsBoardSchema}
 * family, the new optional `projectName` on the do-next card + thread detail, and the persisted
 * `defaultView` settings field. Thin coverage (strict + body-free + every-state-key-present + the
 * defaults); the exhaustive suite is the separate test-author's job.
 */
import { describe, expect, it } from 'vitest';
import {
  BoardThreadCardSchema,
  DEFAULT_APP_SETTINGS,
  DefaultViewSchema,
  DoNextCardSchema,
  ProjectsBoardSchema,
  TASK_STATES,
  ThreadDetailSchema,
} from './index';

const CARD = {
  threadId: 'th-1',
  subject: 'Quarterly report',
  snippet: 'Please send the report',
  sender: 'Petr <petr@acme.com>',
  state: 'needs-reply' as const,
  importance: 'high' as const,
  deadline: null,
  followUpAt: null,
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  hasDraftReady: true,
  promiseDirections: ['my-promise' as const],
};

function emptyGroups(): Record<string, unknown[]> {
  return Object.fromEntries(TASK_STATES.map((s) => [s, []]));
}
function zeroCounts(): Record<string, number> {
  return Object.fromEntries(TASK_STATES.map((s) => [s, 0]));
}

describe('ProjectsBoard schema (D32)', () => {
  const board = {
    generatedAt: '2026-06-05T12:00:00.000Z',
    projects: [
      {
        projectId: 'proj',
        projectName: 'Acme',
        groups: { ...emptyGroups(), 'needs-reply': [CARD] },
        counts: { ...zeroCounts(), 'needs-reply': 1 },
      },
    ],
  };

  it('accepts a valid board and is body-free', () => {
    expect(() => ProjectsBoardSchema.parse(board)).not.toThrow();
    expect(JSON.stringify(board)).not.toContain('"body"');
  });

  it('requires every canonical task state as a key in groups + counts (strict)', () => {
    const entry = {
      projectId: 'proj',
      projectName: 'Acme',
      groups: emptyGroups(),
      counts: zeroCounts(),
    };
    // A full, well-formed entry validates.
    expect(() => ProjectsBoardSchema.parse({ ...board, projects: [entry] })).not.toThrow();
    // Drop the `done` group → fails (missing key).
    const missing = { ...entry.groups } as Record<string, unknown[]>;
    delete missing['done'];
    expect(() =>
      ProjectsBoardSchema.parse({ ...board, projects: [{ ...entry, groups: missing }] }),
    ).toThrow();
    // Add an unknown state key → fails (strict).
    const extra = { ...entry.groups, bogus: [] };
    expect(() =>
      ProjectsBoardSchema.parse({ ...board, projects: [{ ...entry, groups: extra }] }),
    ).toThrow();
  });

  it('a board thread card rejects a smuggled body field (strict)', () => {
    expect(() => BoardThreadCardSchema.parse(CARD)).not.toThrow();
    expect(() => BoardThreadCardSchema.parse({ ...CARD, body: 'secret email text' })).toThrow();
  });

  it('projectName is nullable on the board entry', () => {
    const nullName = {
      ...board,
      projects: [
        { projectId: 'proj', projectName: null, groups: emptyGroups(), counts: zeroCounts() },
      ],
    };
    expect(() => ProjectsBoardSchema.parse(nullName)).not.toThrow();
  });
});

describe('projectName field added to existing read models (D32)', () => {
  const base = {
    threadId: 'th-1',
    subject: 'S',
    snippet: 's',
    sender: 'Petr <petr@acme.com>',
    projectId: 'proj',
    state: 'needs-reply' as const,
    importance: 'normal' as const,
    deadline: null,
    followUpAt: null,
    lastActivityAt: null,
    promiseDirections: [],
    myPromiseUrgency: null,
    theyAskedUrgency: null,
    hasDraftReady: false,
    staleReason: null,
    ageMs: null,
  };

  it('DoNextCard now carries a nullable projectName (alongside projectId)', () => {
    expect(() => DoNextCardSchema.parse({ ...base, projectName: 'Acme' })).not.toThrow();
    expect(() => DoNextCardSchema.parse({ ...base, projectName: null })).not.toThrow();
    // Still required (closes the 7a deferral deterministically).
    expect(() => DoNextCardSchema.parse(base)).toThrow();
  });

  it('ThreadDetail now carries a nullable projectName', () => {
    const detail = {
      threadId: 'th-1',
      projectName: null,
      subject: null,
      sender: null,
      snippet: null,
      lastActivityAt: null,
      messages: [],
      pinnedSummary: null,
      repoFreshness: null,
      lock: null,
    };
    expect(() => ThreadDetailSchema.parse(detail)).not.toThrow();
    expect(() => ThreadDetailSchema.parse({ ...detail, projectName: 'Acme' })).not.toThrow();
  });
});

describe('defaultView settings field (D32)', () => {
  it('defaults to today and accepts only today | three-pane', () => {
    expect(DEFAULT_APP_SETTINGS.defaultView).toBe('today');
    expect(() => DefaultViewSchema.parse('today')).not.toThrow();
    expect(() => DefaultViewSchema.parse('three-pane')).not.toThrow();
    expect(() => DefaultViewSchema.parse('kanban')).toThrow();
  });
});
