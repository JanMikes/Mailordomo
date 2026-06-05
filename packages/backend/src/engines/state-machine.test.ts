import { describe, expect, it } from 'vitest';
import { TASK_STATES, transitionMode } from '@mailordomo/shared';
import { TASK_EVENTS, evaluateTransition, eventTargetState, resolveEvent } from './state-machine';

/**
 * Load-bearing suite for the email-as-task state machine, derived from PROJECT.md §6 INTENT
 * ("Claude auto-sets obvious transitions — I sent → waiting; inbound 'thanks' → done — and
 * proposes ambiguous ones"). Authored independently of the implementation: the expected outcomes
 * below come from the §6 graph + that auto/propose rule, then the engine is checked against them.
 *
 * The closing exhaustive sweep proves the engine is a FAITHFUL interpreter of the shared
 * `TASK_STATE_TRANSITIONS` table (Phase-1 artifact) for every (state, event) pair — it adds no
 * edge and no mode of its own.
 */

describe('state machine — the two §6 AUTO transitions resolve to apply(auto)', () => {
  it('drafted →(user-sent)→ waiting is auto-applied ("I sent → waiting")', () => {
    expect(resolveEvent('drafted', 'user-sent')).toEqual({
      kind: 'apply',
      from: 'drafted',
      to: 'waiting',
      event: 'user-sent',
      mode: 'auto',
    });
    expect(evaluateTransition('drafted', 'waiting')).toEqual({
      from: 'drafted',
      to: 'waiting',
      allowed: true,
      mode: 'auto',
      auto: true,
    });
  });

  it('needs-reply →(inbound-thanks)→ done is auto-applied ("thanks" needs no reply)', () => {
    expect(resolveEvent('needs-reply', 'inbound-thanks')).toEqual({
      kind: 'apply',
      from: 'needs-reply',
      to: 'done',
      event: 'inbound-thanks',
      mode: 'auto',
    });
  });

  it('also auto-applies "I sent → waiting" from follow-up (the sent nudge returns to waiting)', () => {
    expect(resolveEvent('follow-up', 'user-sent')).toMatchObject({
      kind: 'apply',
      to: 'waiting',
      mode: 'auto',
    });
  });
});

describe('state machine — ambiguous transitions resolve to propose (never silently auto)', () => {
  it('a mid-thread "thanks" while awaiting/chasing them is proposed, not auto-closed', () => {
    // From waiting/follow-up a "thanks" is a judgement call (the thread may continue) → propose.
    expect(resolveEvent('waiting', 'inbound-thanks')).toMatchObject({
      kind: 'propose',
      to: 'done',
      mode: 'propose',
    });
    expect(resolveEvent('follow-up', 'inbound-thanks')).toMatchObject({
      kind: 'propose',
      to: 'done',
      mode: 'propose',
    });
  });

  it('explicitly concluding an open waiting/follow-up thread is proposed', () => {
    expect(resolveEvent('waiting', 'mark-done')).toMatchObject({ kind: 'propose', to: 'done' });
    expect(resolveEvent('follow-up', 'mark-done')).toMatchObject({ kind: 'propose', to: 'done' });
  });

  it('reopening a closed thread on new inbound is proposed (a judgement call)', () => {
    expect(resolveEvent('done', 'new-inbound')).toMatchObject({
      kind: 'propose',
      to: 'needs-reply',
      mode: 'propose',
    });
  });
});

describe('state machine — disallowed edges are rejected (no illegal jumps)', () => {
  it('needs-reply cannot jump straight to waiting (must pass through drafted)', () => {
    expect(evaluateTransition('needs-reply', 'waiting')).toEqual({
      from: 'needs-reply',
      to: 'waiting',
      allowed: false,
      mode: undefined,
      auto: false,
    });
    expect(resolveEvent('needs-reply', 'user-sent')).toEqual({
      kind: 'noop',
      from: 'needs-reply',
      event: 'user-sent',
      reason: 'no-legal-transition',
    });
  });

  it('a stale deadline cannot fire before there is anything to wait on', () => {
    expect(resolveEvent('needs-reply', 'deadline-lapsed')).toMatchObject({
      kind: 'noop',
      reason: 'no-legal-transition',
    });
  });
});

describe('state machine — already-in-target is a no-op', () => {
  it('marking done a thread that is already done changes nothing', () => {
    expect(resolveEvent('done', 'mark-done')).toEqual({
      kind: 'noop',
      from: 'done',
      event: 'mark-done',
      reason: 'already-in-target',
    });
  });

  it('user-sent while already waiting, and new-inbound while already needs-reply, are no-ops', () => {
    expect(resolveEvent('waiting', 'user-sent')).toMatchObject({
      kind: 'noop',
      reason: 'already-in-target',
    });
    expect(resolveEvent('needs-reply', 'new-inbound')).toMatchObject({
      kind: 'noop',
      reason: 'already-in-target',
    });
  });
});

describe('state machine — events carry their §6 fixed target state', () => {
  it('eventTargetState maps each event to the state §6 implies', () => {
    expect(eventTargetState('draft-created')).toBe('drafted');
    expect(eventTargetState('user-sent')).toBe('waiting');
    expect(eventTargetState('inbound-thanks')).toBe('done');
    expect(eventTargetState('deadline-lapsed')).toBe('follow-up');
    expect(eventTargetState('new-inbound')).toBe('needs-reply');
    expect(eventTargetState('draft-discarded')).toBe('needs-reply');
    expect(eventTargetState('mark-done')).toBe('done');
  });
});

describe('state machine — every (state, event) is faithful to the shared transition table', () => {
  it('apply ⟺ allowed+auto, propose ⟺ allowed+propose, noop ⟺ self-or-no-edge', () => {
    for (const from of TASK_STATES) {
      for (const event of TASK_EVENTS) {
        const to = eventTargetState(event);
        const outcome = resolveEvent(from, event);

        if (from === to) {
          expect(outcome).toEqual({ kind: 'noop', from, event, reason: 'already-in-target' });
          continue;
        }

        const mode = transitionMode(from, to);
        if (mode === undefined) {
          expect(outcome).toEqual({ kind: 'noop', from, event, reason: 'no-legal-transition' });
        } else if (mode === 'auto') {
          expect(outcome).toEqual({ kind: 'apply', from, to, event, mode: 'auto' });
        } else {
          expect(outcome).toEqual({ kind: 'propose', from, to, event, mode: 'propose' });
        }
      }
    }
  });
});
