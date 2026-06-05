/**
 * The task-state transition table AS DATA, asserted against PROJECT.md §6 intent (NOT derived from
 * the table's own contents). §6 graph:
 *
 *   needs-reply ──▶ drafted ──▶ waiting ──▶ follow-up(+deadline) ──▶ done
 *        └──────────────── (no reply needed: "thanks") ────────────────▶ done
 *
 * §6 names exactly two transitions as AUTO ("I sent → waiting" = drafted→waiting; inbound "thanks"
 * → done = needs-reply→done); everything else is proposed for confirmation.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_TASK_STATE,
  TASK_STATES,
  TASK_STATE_TRANSITIONS,
  TERMINAL_TASK_STATES,
  TRANSITION_MODES,
  allowedNextStates,
  isAllowedTransition,
  transitionMode,
} from './index';
import type { TaskState } from './index';

describe('initial / terminal states (§6)', () => {
  it('starts a freshly-triaged task at needs-reply', () => {
    expect(INITIAL_TASK_STATE).toBe('needs-reply');
  });

  it('treats done as the (reopenable) terminal state', () => {
    expect(TERMINAL_TASK_STATES).toContain('done');
  });

  it('defines exactly the five §6 states', () => {
    expect(TASK_STATES).toEqual(['needs-reply', 'drafted', 'waiting', 'follow-up', 'done']);
  });
});

describe('the §6 forward path edges all exist', () => {
  const forwardPath: [TaskState, TaskState][] = [
    ['needs-reply', 'drafted'],
    ['drafted', 'waiting'],
    ['waiting', 'follow-up'],
    ['follow-up', 'done'],
  ];

  it.each(forwardPath)('allows %s → %s', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(true);
  });

  it('allows the no-reply-needed shortcut needs-reply → done', () => {
    expect(isAllowedTransition('needs-reply', 'done')).toBe(true);
  });
});

describe('the two §6 AUTO transitions are mode "auto"', () => {
  it('drafted → waiting ("I sent") is auto', () => {
    expect(transitionMode('drafted', 'waiting')).toBe('auto');
  });

  it('needs-reply → done (inbound "thanks") is auto', () => {
    expect(transitionMode('needs-reply', 'done')).toBe('auto');
  });
});

describe('ambiguous conclusions are proposed, not auto (§6: "propose ambiguous transitions")', () => {
  it('waiting → done is propose (never silently auto-close a waiting thread)', () => {
    expect(transitionMode('waiting', 'done')).toBe('propose');
  });

  it('follow-up → done is propose', () => {
    expect(transitionMode('follow-up', 'done')).toBe('propose');
  });

  it('done → needs-reply (a reopen by a new inbound message) is propose', () => {
    expect(transitionMode('done', 'needs-reply')).toBe('propose');
  });
});

describe('clearly-forbidden edges are rejected', () => {
  it('forbids done → waiting directly (done only reopens to needs-reply)', () => {
    expect(isAllowedTransition('done', 'waiting')).toBe(false);
    expect(transitionMode('done', 'waiting')).toBeUndefined();
  });

  it('forbids needs-reply → waiting (cannot skip drafted)', () => {
    expect(isAllowedTransition('needs-reply', 'waiting')).toBe(false);
    expect(transitionMode('needs-reply', 'waiting')).toBeUndefined();
  });

  it('forbids needs-reply → follow-up (cannot skip the middle of the path)', () => {
    expect(isAllowedTransition('needs-reply', 'follow-up')).toBe(false);
  });
});

describe('the transition table is well-formed over TaskState', () => {
  const states = new Set<string>(TASK_STATES);
  const modes = new Set<string>(TRANSITION_MODES);

  it('keys the table by exactly the five task states', () => {
    expect(Object.keys(TASK_STATE_TRANSITIONS).sort()).toEqual([...TASK_STATES].sort());
  });

  it('every edge `to` is a valid TaskState and every `mode` is a valid TransitionMode', () => {
    for (const [from, rules] of Object.entries(TASK_STATE_TRANSITIONS)) {
      expect(states.has(from)).toBe(true);
      for (const rule of rules) {
        expect(states.has(rule.to)).toBe(true);
        expect(modes.has(rule.mode)).toBe(true);
      }
    }
  });

  it('allowedNextStates agrees with isAllowedTransition for every ordered pair', () => {
    for (const from of TASK_STATES) {
      const next = new Set<TaskState>(allowedNextStates(from));
      for (const to of TASK_STATES) {
        expect(isAllowedTransition(from, to)).toBe(next.has(to));
      }
    }
  });

  it('never declares a self-loop as auto without §6 warrant (no state silently auto-advances to itself)', () => {
    for (const from of TASK_STATES) {
      expect(isAllowedTransition(from, from)).toBe(false);
    }
  });
});
