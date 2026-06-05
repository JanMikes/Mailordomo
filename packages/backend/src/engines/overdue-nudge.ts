/**
 * The ONE sanctioned auto-draft — the overdue NUDGE for a lapsed INBOUND promise (PROJECT.md §6).
 *
 * §6: the daemon "does not draft unprompted — EXCEPT the one sanctioned case: when an INBOUND promise
 * lapses (someone promised YOU a reply and the deadline passed), it auto-drafts a nudge, ready to
 * send (still requires a manual send)." This module is the PURE TRIGGER half of that: the predicate
 * that decides whether a promise should produce a nudge. The model call + the saveDraft-only write
 * live in `claude/nudge.ts` (the runner-driven half) so this engine stays pure and IO-free.
 *
 * GOLDEN RULE #1 (sending is ALWAYS manual) is honored STRUCTURALLY: nothing here, and nothing in the
 * nudge draft path, imports `sendReply` or anything under `smtp/**`. The nudge produces a DRAFT via an
 * INJECTED filer (a `saveDraft`-shaped function the caller wires in — never the daemon, which is
 * ESLint-barred from `smtp/**`). It is therefore structurally impossible for the nudge to transmit.
 *
 * The trigger fires for EXACTLY: direction `awaiting-them` (their promise to me) AND status `overdue`
 * (resolved `due_at` strictly in the past, still open). Any other direction or status ⇒ no nudge.
 */
import type { PromiseRecord } from '@mailordomo/shared';

/**
 * PURE predicate: does this promise warrant the sanctioned overdue-nudge? True iff it is an INBOUND
 * promise (`awaiting-them` — they owe me) that has LAPSED (`status === 'overdue'`). Anything I owe
 * (`my-promise`/`they-asked`) never nudges THEM; an `open`/`fulfilled`/`cancelled` inbound promise
 * does not (it isn't lapsed / it's resolved). This is the single gate the daemon consults.
 */
export function shouldNudge(promise: Pick<PromiseRecord, 'direction' | 'status'>): boolean {
  return promise.direction === 'awaiting-them' && promise.status === 'overdue';
}

/**
 * Belt-and-braces variant that recomputes lapsed-ness from `due_at` + an injected `now` rather than
 * trusting a possibly-stale `status` — for callers that have not run `reconcileExisting` first. A
 * promise nudges iff it is `awaiting-them`, NOT already `fulfilled`/`cancelled`, and either already
 * flagged `overdue` OR has a resolved `due_at` strictly before `now`. Pure.
 */
export function shouldNudgeAt(
  promise: Pick<PromiseRecord, 'direction' | 'status' | 'due_at'>,
  nowIso: string,
): boolean {
  if (promise.direction !== 'awaiting-them') return false;
  if (promise.status === 'fulfilled' || promise.status === 'cancelled') return false;
  if (promise.status === 'overdue') return true;
  if (promise.due_at === null) return false;
  const due = Date.parse(promise.due_at);
  const now = Date.parse(nowIso);
  return !Number.isNaN(due) && !Number.isNaN(now) && due < now;
}

/** Select every promise in a set that should be nudged (the daemon's stale-pass output → nudges). */
export function selectNudgeable(promises: readonly PromiseRecord[]): PromiseRecord[] {
  return promises.filter((promise) => shouldNudge(promise));
}
