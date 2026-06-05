/**
 * Fixed model routing asserted against PROJECT.md §4 + Golden rule #6 ("Never route outgoing-text
 * generation below Opus"). §4 table:
 *   triage / state classification        → Haiku
 *   promise extraction (structured)      → Haiku
 *   summarize / digest / do-next ranking → Sonnet
 *   drafts & repo-aware technical answers→ Opus
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_ALIASES,
  MODEL_RANK,
  MODEL_ROUTING,
  OUTGOING_TEXT_TASK_KINDS,
  TASK_KINDS,
  assertOutgoingTextRouting,
  modelForTask,
} from './index';
import type { ModelAlias, TaskKind } from './index';

const EXPECTED_ROUTING: Record<TaskKind, ModelAlias> = {
  triage: 'haiku',
  'promise-extraction': 'haiku',
  summarize: 'sonnet',
  digest: 'sonnet',
  rank: 'sonnet',
  draft: 'opus',
  nudge: 'opus',
  'repo-answer': 'opus',
};

describe('MODEL_ROUTING matches PROJECT.md §4 exactly', () => {
  it('maps every task kind to the §4 model', () => {
    expect(MODEL_ROUTING).toEqual(EXPECTED_ROUTING);
  });

  it('modelForTask agrees with the table for every kind', () => {
    for (const kind of TASK_KINDS) {
      expect(modelForTask(kind)).toBe(EXPECTED_ROUTING[kind]);
    }
  });

  it('routes every kind to a real model alias', () => {
    const aliases = new Set<string>(MODEL_ALIASES);
    for (const kind of TASK_KINDS) {
      expect(aliases.has(modelForTask(kind))).toBe(true);
    }
  });
});

describe('MODEL_RANK orders the aliases haiku < sonnet < opus', () => {
  it('ranks by capability/cost', () => {
    expect(MODEL_RANK.haiku).toBeLessThan(MODEL_RANK.sonnet);
    expect(MODEL_RANK.sonnet).toBeLessThan(MODEL_RANK.opus);
  });
});

describe('Golden rule #6 — never route outgoing-text below Opus', () => {
  it('treats draft and nudge as the outgoing-text kinds', () => {
    expect([...OUTGOING_TEXT_TASK_KINDS].sort()).toEqual(['draft', 'nudge']);
  });

  it('routes every outgoing-text kind to opus (the top rank)', () => {
    for (const kind of OUTGOING_TEXT_TASK_KINDS) {
      expect(modelForTask(kind)).toBe('opus');
      expect(MODEL_RANK[modelForTask(kind)]).toBe(MODEL_RANK.opus);
    }
  });

  it('passes assertOutgoingTextRouting on the real routing map', () => {
    expect(() => assertOutgoingTextRouting()).not.toThrow();
    expect(() => assertOutgoingTextRouting(MODEL_ROUTING)).not.toThrow();
  });

  it('throws when a tampered map routes draft below opus', () => {
    expect(() => assertOutgoingTextRouting({ ...MODEL_ROUTING, draft: 'haiku' })).toThrow();
    expect(() => assertOutgoingTextRouting({ ...MODEL_ROUTING, draft: 'sonnet' })).toThrow();
  });

  it('throws when a tampered map routes nudge below opus', () => {
    expect(() => assertOutgoingTextRouting({ ...MODEL_ROUTING, nudge: 'haiku' })).toThrow();
  });
});
