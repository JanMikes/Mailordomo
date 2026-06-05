/**
 * On-signal reply DRAFTING + the replay-based REFINE chat (PROJECT.md §6/§11; PLAN.md §7 Phase 7b,
 * decision D31). Modeled on `claude/nudge.ts`: it produces TEXT ONLY and FILES nothing — there is no
 * `smtp/**` import on this path, so it is structurally incapable of sending (Golden rule #1). The
 * caller (the API endpoint) persists the produced body in the LOCAL `DraftStore` and records
 * body-free `DraftMeta` on the server.
 *
 * GOLDEN RULE #6 — OPUS FLOOR: `taskKind: 'draft'` routes to OPUS via the shared `MODEL_ROUTING` map
 * (a draft is outgoing text). The spec never names a model, so a caller cannot route it below Opus;
 * the floor is enforced compile-time (`OUTGOING_TEXT_MODELS`) + runtime (`assertOutgoingTextRouting`,
 * re-asserted on import below for defense in depth).
 *
 * GOLDEN RULE #5 — REPLAY, NOT RESUME: {@link refineDraft} reconstructs the multi-turn refine chat by
 * REPLAYING the full {@link RefineTurn} transcript into a FRESH stateless `claude -p` call each turn —
 * never `--continue`/`--resume`. The backend owns the transcript (in `DraftStore`); the frontend
 * posts only the new instruction.
 *
 * TONE LAYERING (the first draft consumer): the per-task `draft.md` system prompt is LAYERED with
 * `--append-system-prompt-file <resolvedToneFile>` (project → mailbox → contact, contact wins). The
 * caller resolves the composed tone document to a file path (via `tone/resolve.ts` + a temp file) and
 * passes it as `appendSystemPromptFile`; absent → the draft runs on `draft.md` alone.
 */
import type { ModelAlias } from '@mailordomo/shared';
import { assertOutgoingTextRouting, modelForTask } from '@mailordomo/shared';
import type { RefineTurn } from '../drafts/types';
import { promptPath } from './prompts';
import type { ThreadMessageInput } from './summarize';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

// Self-check on import (defense in depth; mirrors `routing.ts`): `draft` is outgoing text and MUST
// route to Opus. If the routing map ever regressed below Opus, this throws at module load.
assertOutgoingTextRouting();

/** A thread message handed to the draft job (body read LOCALLY). Reuses the summarize input shape. */
export type DraftMessageInput = ThreadMessageInput;

/** The context a draft is grounded in: the thread + an optional user instruction. */
export interface DraftContext {
  /** Thread subject (the reply threads under it; rendered as "Re: …" by the send path). */
  readonly subject: string;
  /** Display name / address being replied to (optional; helps the model address the reply). */
  readonly recipient?: string;
  /** The thread messages, oldest → newest. Bodies are read locally (golden rule #3). */
  readonly messages: readonly DraftMessageInput[];
  /** The user's instruction-textarea text ("context for Claude"), folded into the prompt. Optional. */
  readonly instructionText?: string;
}

/** The default first-turn instruction when the user gives no explicit guidance. */
export const DEFAULT_DRAFT_INSTRUCTION = 'Draft a reply to the latest message in this thread.';

/** Build options shared by generate/refine — the optional appended tone file + runner knobs. */
export interface DraftBuildOptions {
  /** `--append-system-prompt-file` — the resolved, composed tone-memory document path (optional). */
  readonly appendSystemPromptFile?: string;
  readonly timeoutMs?: number;
  readonly bare?: boolean;
}

/** Render the thread (oldest → newest) into a prompt block. PURE — deterministic for fixtures. */
function renderThreadBlock(context: DraftContext): string {
  const lines: string[] = [];
  if (context.subject.trim() !== '') {
    lines.push(`Thread subject: ${context.subject}`);
  }
  if (context.recipient !== undefined && context.recipient.trim() !== '') {
    lines.push(`Replying to: ${context.recipient}`);
  }
  context.messages.forEach((message, index) => {
    lines.push('', `--- Message ${index + 1} ---`, `From: ${message.sender}`);
    if (message.date !== undefined) lines.push(`Date: ${message.date}`);
    if (message.subject !== undefined) lines.push(`Subject: ${message.subject}`);
    lines.push('', message.body);
  });
  return lines.join('\n');
}

/** PURE: the user prompt for the FIRST draft — the thread block + the (optional) instruction. */
export function renderDraftPrompt(context: DraftContext): string {
  const instruction =
    context.instructionText !== undefined && context.instructionText.trim() !== ''
      ? context.instructionText.trim()
      : DEFAULT_DRAFT_INSTRUCTION;
  return [
    renderThreadBlock(context),
    '',
    'Draft a reply to the latest message in this thread, following this instruction:',
    instruction,
    '',
    'Output only the reply body.',
  ].join('\n');
}

/**
 * PURE: the user prompt for a REFINE turn — the thread block, then the REPLAYED transcript (my
 * instructions + your drafts, oldest first), then the new instruction. This is the full-history replay
 * that makes the stateless refine call work (golden rule #5).
 */
export function renderRefinePrompt(
  context: DraftContext,
  transcript: readonly RefineTurn[],
  instruction: string,
): string {
  const lines: string[] = [
    renderThreadBlock(context),
    '',
    'You previously drafted a reply and we have been refining it together. Our conversation so far',
    '(my instructions and your drafts), oldest first:',
  ];
  for (const turn of transcript) {
    lines.push('', turn.role === 'user' ? '>>> My instruction:' : '>>> Your draft:', turn.content);
  }
  lines.push(
    '',
    'Now revise the latest draft according to this new instruction:',
    instruction,
    '',
    'Output only the revised reply body.',
  );
  return lines.join('\n');
}

/**
 * PURE: build a draft {@link JobSpec} from a prompt. `taskKind: 'draft'` routes to OPUS; the system
 * prompt is the editable `draft.md`, optionally LAYERED with the resolved tone file. No `--json-schema`
 * (a draft is prose — the `result` text). Read-only tools (the draft job may read repo context later).
 */
export function buildDraftSpec(prompt: string, options: DraftBuildOptions = {}): JobSpec {
  return {
    taskKind: 'draft',
    prompt,
    systemPromptFile: promptPath('draft'),
    ...(options.appendSystemPromptFile !== undefined
      ? { appendSystemPromptFile: options.appendSystemPromptFile }
      : {}),
    allowedTools: ['Read'],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** Extract the drafted body from a completed job (throws on an error envelope or empty result). */
export function parseDraftBody(result: JobResult): string {
  if (result.isError) {
    throw new Error(
      `draft job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  const body = result.text.trim();
  if (body === '') {
    throw new Error('draft job returned an empty draft');
  }
  return body;
}

/** The outcome of a draft/refine call: the body + the model alias + cost + the appended transcript. */
export interface DraftGeneration {
  /** The produced draft body (LOCAL ONLY — the caller persists it in the `DraftStore`). */
  readonly body: string;
  /** The model ALIAS that produced it (always `opus` for drafts) — for the UI badge + DraftMeta. */
  readonly model: ModelAlias;
  /** Notional usage for the call (throttle signal; not a dollar charge). */
  readonly costUsd: number;
  /** The full refine transcript after this turn (the FIRST user turn is the instruction). */
  readonly transcript: RefineTurn[];
}

/**
 * Generate the FIRST draft for a thread: run the OPUS `draft` job through the runner seam, returning
 * the body + a two-turn transcript (`[{user: instruction}, {assistant: body}]`). Produces text only —
 * the caller persists it in the `DraftStore` and records body-free `DraftMeta`. Pass the FAKE runner
 * in tests for determinism.
 */
export async function generateDraft(
  runner: ClaudeRunner,
  context: DraftContext,
  options: DraftBuildOptions = {},
): Promise<DraftGeneration> {
  const instruction =
    context.instructionText !== undefined && context.instructionText.trim() !== ''
      ? context.instructionText.trim()
      : DEFAULT_DRAFT_INSTRUCTION;
  const spec = buildDraftSpec(renderDraftPrompt(context), options);
  const result = await runner.run(spec);
  const body = parseDraftBody(result);
  return {
    body,
    model: modelForTask('draft'),
    costUsd: result.costUsd,
    transcript: [
      { role: 'user', content: instruction },
      { role: 'assistant', content: body },
    ],
  };
}

/**
 * Refine an existing draft: REPLAY the prior `transcript` + the new `instruction` into a FRESH OPUS
 * call (golden rule #5 — no `--continue`/`--resume`), returning the new body + the transcript extended
 * with `[{user: instruction}, {assistant: newBody}]`. The caller persists the result.
 */
export async function refineDraft(
  runner: ClaudeRunner,
  context: DraftContext,
  transcript: readonly RefineTurn[],
  instruction: string,
  options: DraftBuildOptions = {},
): Promise<DraftGeneration> {
  const spec = buildDraftSpec(renderRefinePrompt(context, transcript, instruction), options);
  const result = await runner.run(spec);
  const body = parseDraftBody(result);
  return {
    body,
    model: modelForTask('draft'),
    costUsd: result.costUsd,
    transcript: [
      ...transcript,
      { role: 'user', content: instruction },
      { role: 'assistant', content: body },
    ],
  };
}
