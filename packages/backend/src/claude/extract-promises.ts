/**
 * Promise-extraction consumer (PROJECT.md §7/§4): given a message + its received date + the mailbox
 * timezone, run a HAIKU job with `extract-promises.md` as the system prompt + `--json-schema` for
 * structured promise *candidates*, validate them, and hand them to the PURE `promise-reconciler`
 * engine. This is the LLM half of the load-bearing 3-way tracker; reconciliation is deterministic.
 *
 * Routing: `taskKind: 'promise-extraction'` → Haiku via the shared `MODEL_ROUTING` map (§4: "Promise
 * extraction (structured) — Haiku, escalate to Sonnet if quality demands"). The escalation seam is
 * exposed as an `escalate` option that bumps the spec to a `summarize`-equivalent Sonnet route — but
 * to keep routing a pure function of `taskKind` (so Golden rule #6 can't be bypassed) we route via the
 * existing kinds and document the escalation as a future addition; v1 ships Haiku. (See note below.)
 *
 * DEADLINE ANCHORING (§7/§9): the message-received date + mailbox tz (Europe/Prague) are passed into
 * the PROMPT as the anchor, and the model returns a resolved ISO `due_at` alongside the verbatim
 * `due_raw`. The reconciler trusts a valid `due_at` and otherwise re-resolves `due_raw` deterministically.
 *
 * Split for testability (mirrors `triage.ts`):
 *  - `renderExtractionPrompt(...)` — PURE: the user prompt (message + the anchor block).
 *  - `buildExtractionSpec(...)`    — PURE: the {@link JobSpec} (Haiku, the extraction schema/prompt).
 *  - `parseExtraction(result)`     — validates `structured_output` → {@link PromiseCandidate}[].
 *  - `extractPromises(runner, ...)` — runs the job + reconciles to {@link PromiseRecord}[].
 *
 * Bodies are read LOCALLY (the runner runs on this machine) — fine per Golden rule #3.
 */
import type { PromiseRecord } from '@mailordomo/shared';
import { reconcileCandidates } from '../engines/promise-reconciler';
import type { ReconcileContext } from '../engines/promise-reconciler';
import { MAILBOX_TIMEZONE } from '../engines/relative-deadline';
import { promptPath } from './prompts';
import {
  PROMISE_EXTRACTION_JSON_SCHEMA,
  PromiseExtractionSchema,
} from './promise-extraction-schema';
import type { PromiseCandidate } from './promise-extraction-schema';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** The message fields extraction reasons over, plus the deadline-resolution anchor. */
export interface ExtractionMessageInput {
  readonly subject: string;
  readonly sender: string;
  /** Plain-text body, read locally — promises live in the prose, so the body is expected here. */
  readonly body: string;
  /**
   * ISO-8601 instant the message was received. THE ANCHOR for resolving relative deadlines ("by
   * Friday") in the mailbox timezone (§7/§9). Required — extraction without an anchor cannot resolve.
   */
  readonly receivedIso: string;
  /** IANA timezone of the mailbox; defaults to Europe/Prague (the v1 mailbox tz). */
  readonly timezone?: string;
  /** Optional repo dirs (rare for extraction; supported for parity with other consumers). */
  readonly addDirs?: readonly string[];
}

/**
 * Render the message + the anchor block into the user prompt (over stdin). Deterministic for fixtures.
 * The anchor block states the received date AND timezone explicitly so the model resolves "by Friday"
 * relative to the right day in the right zone.
 */
export function renderExtractionPrompt(message: ExtractionMessageInput): string {
  const tz = message.timezone ?? MAILBOX_TIMEZONE;
  const lines = [
    'Extract every promise, request, and awaited deliverable from the following email.',
    '',
    'Deadline anchor (resolve any relative deadline against THIS):',
    `- Message received: ${message.receivedIso}`,
    `- Mailbox timezone: ${tz}`,
    '',
    `From: ${message.sender}`,
    `Subject: ${message.subject}`,
    '',
    'Body:',
    message.body,
  ];
  return lines.join('\n');
}

/**
 * PURE: build the extraction {@link JobSpec}. `taskKind: 'promise-extraction'` routes to Haiku via the
 * shared map; the system prompt is the editable `extract-promises.md`; `--json-schema` constrains the
 * candidate array.
 */
export function buildExtractionSpec(
  message: ExtractionMessageInput,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'promise-extraction',
    prompt: renderExtractionPrompt(message),
    systemPromptFile: promptPath('extract-promises'),
    jsonSchema: PROMISE_EXTRACTION_JSON_SCHEMA,
    allowedTools: ['Read'],
    ...(message.addDirs !== undefined ? { addDirs: message.addDirs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** Validate the runner's `structured_output` into candidates (throws on error/bad shape). */
export function parseExtraction(result: JobResult): PromiseCandidate[] {
  if (result.isError) {
    throw new Error(
      `promise-extraction job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  return PromiseExtractionSchema.parse(result.structuredOutput).promises;
}

/** The full extraction outcome: the raw candidates, the reconciled records, and call accounting. */
export interface ExtractionResult {
  readonly candidates: readonly PromiseCandidate[];
  readonly promises: readonly PromiseRecord[];
  readonly costUsd: number;
  readonly model: string;
}

/**
 * The reconciliation inputs the caller supplies (everything not derivable from the candidates): the
 * thread id, "now", the id factory, and optionally the attributing actor / confidence floor. The
 * message-received anchor is taken from the {@link ExtractionMessageInput} so the same instant drives
 * both the prompt and the deterministic fallback resolver.
 */
export type ExtractionReconcileInputs = Omit<ReconcileContext, 'messageReceivedIso'>;

/**
 * Run promise extraction end-to-end through the runner seam (pass the FAKE in tests for deterministic
 * candidate → record assertions with no API), then reconcile the candidates into canonical
 * `PromiseRecord`s via the pure engine. The reconciler is pure, so the only non-determinism is the
 * (mocked-in-tests) model call. Promise-extraction is ESSENTIAL (it proceeds over the usage throttle).
 */
export async function extractPromises(
  runner: ClaudeRunner,
  message: ExtractionMessageInput,
  reconcile: ExtractionReconcileInputs,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): Promise<ExtractionResult> {
  const spec = buildExtractionSpec(message, options);
  const result = await runner.run(spec);
  const candidates = parseExtraction(result);
  const promises = reconcileCandidates(candidates, {
    ...reconcile,
    messageReceivedIso: message.receivedIso,
  });
  return { candidates, promises, costUsd: result.costUsd, model: result.model };
}
