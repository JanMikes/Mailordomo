/**
 * The sanctioned overdue-NUDGE auto-draft — the runner-driven half (PROJECT.md §6 / Golden rule #1).
 *
 * When an INBOUND promise lapses (`engines/overdue-nudge.ts#shouldNudge` is true), this produces an
 * OPUS draft of a polite chase-up using `nudge.md`, then FILES it as a DRAFT — never sends. It is the
 * ONE place the daemon may draft unprompted; it still requires a manual send.
 *
 * GOLDEN RULE #1 — STRUCTURAL GUARANTEE OF "NO SEND":
 *  - This module does NOT import `sendReply`, `saveDraft`, `nodemailer`, or anything under `smtp/**`.
 *    It cannot transmit; it cannot even reach the SMTP module.
 *  - The actual draft WRITE is performed by an INJECTED {@link DraftFiler} the CALLER supplies. The
 *    intended wiring binds it to `smtp/send.ts#saveDraft` (the draft-only, transport-free path) — but
 *    that binding happens in the API/orchestrator, NOT in the daemon (which ESLint bars from `smtp/**`).
 *    The `DraftFiler` interface is deliberately a NARROW, save-only seam: it has no "send" verb, so a
 *    caller cannot accidentally pass a transmitting function and have it typecheck as a nudge filer.
 *  - Result: it is structurally impossible for the nudge to send. The Phase 5 behavioral test asserts
 *    the produced effect is a DRAFT (filed), never a transmission.
 *
 * Routing: `taskKind: 'nudge'` → OPUS via the shared map (Golden rule #6 — outgoing text is never
 * below Opus; the routing floor is compile-time + runtime enforced in `@mailordomo/shared`).
 */
import type { Actor, PromiseRecord } from '@mailordomo/shared';
import { AUTOMATED_ACTOR } from '@mailordomo/shared';
import { promptPath } from './prompts';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** Context for drafting a nudge: the lapsed promise + who/what the chase is about. */
export interface NudgeContext {
  /** The lapsed INBOUND promise being chased (direction `awaiting-them`, status `overdue`). */
  readonly promise: Pick<PromiseRecord, 'text' | 'due_at' | 'due_raw' | 'direction' | 'status'>;
  /** Display name / address of the recipient (the party who owes me). */
  readonly recipient: string;
  /** Subject of the thread being followed up (the draft replies into it). */
  readonly subject: string;
  /** Optional prior-message context to ground the nudge (the original ask + their commitment). */
  readonly threadContext?: string;
  /** ISO-8601 "now", so the prompt can phrase "this was due N days ago" naturally. Optional. */
  readonly nowIso?: string;
}

/** Render the nudge user prompt (over stdin). Deterministic for fixtures. */
export function renderNudgePrompt(context: NudgeContext): string {
  const lines = [
    'Draft a brief, polite follow-up that nudges the recipient about an overdue commitment they made to me.',
    '',
    `Recipient: ${context.recipient}`,
    `Thread subject: ${context.subject}`,
    '',
    'What they committed to (now overdue):',
    context.promise.text,
  ];
  if (context.promise.due_raw !== null && context.promise.due_raw !== undefined) {
    lines.push(`Stated deadline: ${context.promise.due_raw}`);
  }
  if (context.promise.due_at !== null && context.promise.due_at !== undefined) {
    lines.push(`Resolved deadline: ${context.promise.due_at}`);
  }
  if (context.nowIso !== undefined) {
    lines.push(`Now: ${context.nowIso}`);
  }
  if (context.threadContext !== undefined && context.threadContext.trim() !== '') {
    lines.push('', 'Prior context:', context.threadContext);
  }
  return lines.join('\n');
}

/**
 * PURE: build the nudge {@link JobSpec}. `taskKind: 'nudge'` routes to OPUS via the shared map; the
 * system prompt is the editable `nudge.md`. No `--json-schema`: the draft is prose (the `result` text).
 */
export function buildNudgeSpec(
  context: NudgeContext,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'nudge',
    prompt: renderNudgePrompt(context),
    systemPromptFile: promptPath('nudge'),
    allowedTools: ['Read'],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** Extract the drafted nudge body from a completed job (throws on error/empty). */
export function parseNudgeDraft(result: JobResult): string {
  if (result.isError) {
    throw new Error(
      `nudge job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  const body = result.text.trim();
  if (body === '') {
    throw new Error('nudge job returned an empty draft');
  }
  return body;
}

/** The minimal payload handed to the filer — the draft to SAVE (never send). */
export interface NudgeDraft {
  readonly subject: string;
  readonly to: string;
  readonly body: string;
  /** Model id that produced the draft (for the DraftMeta record). */
  readonly model: string;
  /** Actor attributed with creating the draft (default {@link AUTOMATED_ACTOR} — the daemon). */
  readonly author: Actor;
}

/**
 * The narrow SAVE-ONLY seam the nudge writes through. It has EXACTLY one verb — `saveDraft` — and NO
 * way to transmit. The caller binds this to `smtp/send.ts#saveDraft` (compose + IMAP-APPEND to Drafts).
 * Modeled here without importing any `smtp/**` type so this module has no path to the send module.
 */
export interface DraftFiler {
  /** Persist the draft (e.g. compose + APPEND to the Drafts folder). Returns where it was filed. */
  saveDraft(draft: NudgeDraft): Promise<NudgeFiledResult>;
}

/** The outcome of filing the draft. */
export interface NudgeFiledResult {
  /** The Message-ID of the composed draft. */
  readonly messageId: string;
  /** The folder the draft was filed into, or null if no Drafts folder was resolvable. */
  readonly filedTo: string | null;
}

/** The result of drafting a nudge: the draft body + where it was filed + call accounting. */
export interface NudgeResult {
  readonly body: string;
  readonly filed: NudgeFiledResult;
  readonly costUsd: number;
  readonly model: string;
}

/**
 * Produce the sanctioned overdue-nudge: run the OPUS job through the runner seam, then FILE the result
 * as a draft via the injected {@link DraftFiler}. NEVER sends — there is no transport on this path and
 * no `smtp/**` import. Pass the FAKE runner + a capturing filer in tests to assert "a DRAFT was filed,
 * nothing was sent". The CALLER is responsible for only invoking this when `shouldNudge` is true.
 */
export async function draftNudge(
  runner: ClaudeRunner,
  context: NudgeContext,
  filer: DraftFiler,
  options: { readonly timeoutMs?: number; readonly bare?: boolean; readonly author?: Actor } = {},
): Promise<NudgeResult> {
  const spec = buildNudgeSpec(context, options);
  const result = await runner.run(spec);
  const body = parseNudgeDraft(result);
  const filed = await filer.saveDraft({
    subject: context.subject,
    to: context.recipient,
    body,
    model: result.model,
    author: options.author ?? AUTOMATED_ACTOR,
  });
  return { body, filed, costUsd: result.costUsd, model: result.model };
}
