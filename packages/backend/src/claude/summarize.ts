/**
 * Thread summarization consumer (PROJECT.md §4/§9): given a thread's messages, run a SONNET job with
 * `summarize.md` as the system prompt → a concise free-text summary (the envelope's `result` field).
 *
 * No `--json-schema` here: a summary is prose, returned as `text`. Split for testability:
 *  - `renderThreadPrompt(messages)` — PURE: the user prompt (the thread, oldest→newest).
 *  - `buildSummarizeSpec(messages)` — PURE: the {@link JobSpec} (taskKind 'summarize' → Sonnet).
 *  - `summarizeThread(runner, messages)` — runs the job, returns the summary text + cost/model.
 *
 * Bodies are read LOCALLY — this is the local machine (golden rule #3).
 */
import { promptPath } from './prompts';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** One message in a thread, in the order it should be summarized (oldest first). */
export interface ThreadMessageInput {
  readonly sender: string;
  readonly date?: string;
  readonly subject?: string;
  /** Plain-text body, read locally. */
  readonly body: string;
}

/** Render a thread into the summarization user prompt (oldest → newest). */
export function renderThreadPrompt(
  messages: readonly ThreadMessageInput[],
  options: { readonly subject?: string } = {},
): string {
  const lines: string[] = ['Summarize the following email thread.'];
  if (options.subject !== undefined && options.subject.trim() !== '') {
    lines.push('', `Thread subject: ${options.subject}`);
  }
  messages.forEach((message, index) => {
    lines.push('', `--- Message ${index + 1} ---`, `From: ${message.sender}`);
    if (message.date !== undefined) {
      lines.push(`Date: ${message.date}`);
    }
    if (message.subject !== undefined) {
      lines.push(`Subject: ${message.subject}`);
    }
    lines.push('', message.body);
  });
  return lines.join('\n');
}

/** PURE: build the summarize {@link JobSpec}. `taskKind: 'summarize'` routes to Sonnet. */
export function buildSummarizeSpec(
  messages: readonly ThreadMessageInput[],
  options: { readonly subject?: string; readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'summarize',
    prompt: renderThreadPrompt(messages, {
      ...(options.subject !== undefined ? { subject: options.subject } : {}),
    }),
    systemPromptFile: promptPath('summarize'),
    allowedTools: ['Read'],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** The summary outcome: the prose summary + cost/model of the underlying call. */
export interface SummaryResult {
  readonly summary: string;
  readonly costUsd: number;
  readonly model: string;
}

/** Extract the summary text from a completed job (throws on an error envelope or empty result). */
export function parseSummary(result: JobResult): SummaryResult {
  if (result.isError) {
    throw new Error(
      `summarize job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  const summary = result.text.trim();
  if (summary === '') {
    throw new Error('summarize job returned an empty summary');
  }
  return { summary, costUsd: result.costUsd, model: result.model };
}

/**
 * Run summarization end-to-end through the runner seam (pass the FAKE in tests). For throttle-gated
 * dispatch prefer `queue.enqueue(buildSummarizeSpec(...))` (summaries are a DEFERRABLE kind, so they
 * are the first to feel usage-throttle backpressure when the subscription window is heavily used).
 */
export async function summarizeThread(
  runner: ClaudeRunner,
  messages: readonly ThreadMessageInput[],
  options: { readonly subject?: string; readonly timeoutMs?: number; readonly bare?: boolean } = {},
): Promise<SummaryResult> {
  const spec = buildSummarizeSpec(messages, options);
  const result = await runner.run(spec);
  return parseSummary(result);
}
