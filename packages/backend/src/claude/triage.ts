/**
 * Triage consumer (PROJECT.md §4/§6): given a message, run a HAIKU job with `triage.md` as the
 * system prompt + `--json-schema` for a structured decision, validate it, and MAP it to a
 * state-machine event via `resolveEvent` (`engines/state-machine.ts`).
 *
 * Split for testability:
 *  - `buildTriageSpec(message)` — PURE: the {@link JobSpec} (taskKind 'triage' → Haiku, the triage
 *    prompt file, the triage schema). Unit-testable without a runner.
 *  - `dispositionToEvent(...)` — PURE: triage disposition → {@link TaskEvent}.
 *  - `triageMessage(runner, message, from)` — runs the job and returns the decision + the
 *    state-machine {@link TransitionOutcome} from the thread's current state.
 *
 * Bodies are read LOCALLY (the runner runs on this machine) — fine per golden rule #3.
 */
import type { TaskState } from '@mailordomo/shared';
import type { TaskEvent, TransitionOutcome } from '../engines/state-machine';
import { resolveEvent } from '../engines/state-machine';
import { promptPath } from './prompts';
import { TRIAGE_JSON_SCHEMA, TriageDecisionSchema } from './triage-schema';
import type { TriageDecision } from './triage-schema';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** The message fields triage reasons over. The body is optional (snippet alone is often enough). */
export interface TriageMessageInput {
  readonly subject: string;
  readonly sender: string;
  readonly snippet: string;
  /** Full plain-text body, read locally. Optional — omit to triage on subject/snippet only. */
  readonly body?: string;
  /** Optional repo dirs to give Claude read access to (rare for triage; supported for parity). */
  readonly addDirs?: readonly string[];
}

/** Render the message into the user prompt passed over stdin. Kept deterministic for fixtures. */
export function renderTriagePrompt(message: TriageMessageInput): string {
  const lines = [
    'Classify the following email for a task-oriented inbox.',
    '',
    `From: ${message.sender}`,
    `Subject: ${message.subject}`,
    '',
    'Snippet:',
    message.snippet,
  ];
  if (message.body !== undefined && message.body.trim() !== '') {
    lines.push('', 'Body:', message.body);
  }
  return lines.join('\n');
}

/**
 * PURE: build the triage {@link JobSpec}. `taskKind: 'triage'` routes to Haiku via the shared map;
 * the system prompt is the editable `triage.md`; `--json-schema` constrains the decision.
 */
export function buildTriageSpec(
  message: TriageMessageInput,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'triage',
    prompt: renderTriagePrompt(message),
    systemPromptFile: promptPath('triage'),
    jsonSchema: TRIAGE_JSON_SCHEMA,
    allowedTools: ['Read'],
    ...(message.addDirs !== undefined ? { addDirs: message.addDirs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/**
 * PURE: map a validated triage disposition to the semantic {@link TaskEvent} the state machine
 * consumes (PROJECT.md §6). The event's TARGET state and whether the move is auto-vs-propose are the
 * state machine's job (it reads the shared transition table); this only chooses the event:
 *   - 'needs-reply'     → `new-inbound`     (a new message re-obligates the thread → needs-reply)
 *   - 'no-reply-needed' → `inbound-thanks`  (a thanks/FYI that closes → done; auto only from
 *                          needs-reply, else proposed — decided by the table)
 *   - 'fyi'             → `null`            (informational; no state change)
 */
export function dispositionToEvent(decision: TriageDecision): TaskEvent | null {
  switch (decision.disposition) {
    case 'needs-reply':
      return 'new-inbound';
    case 'no-reply-needed':
      return 'inbound-thanks';
    case 'fyi':
      return null;
  }
}

/** Validate the runner's `structured_output` into a {@link TriageDecision} (throws on a bad shape). */
export function parseTriageDecision(result: JobResult): TriageDecision {
  if (result.isError) {
    throw new Error(
      `triage job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  return TriageDecisionSchema.parse(result.structuredOutput);
}

/** The full triage outcome: the model's decision + the state-machine response from `fromState`. */
export interface TriageResult {
  readonly decision: TriageDecision;
  /** The event chosen for the state machine, or `null` for an FYI (no state change). */
  readonly event: TaskEvent | null;
  /** The state-machine outcome (apply/propose/noop), or `null` when there is no event. */
  readonly transition: TransitionOutcome | null;
  /** Cost/usage of the underlying call (already accounted by the queue, surfaced for callers). */
  readonly costUsd: number;
  readonly model: string;
}

/**
 * Run triage end-to-end: dispatch the Haiku job through the runner, validate the decision, choose a
 * state-machine event, and resolve it against the thread's current state. The runner is the seam —
 * pass the FAKE in tests for deterministic triage→state assertions with no API.
 *
 * NOTE: when the runner is a {@link ClaudeJobQueue}, prefer `queue.enqueue(buildTriageSpec(...))`
 * directly so the usage-throttle gate applies; this helper takes a bare {@link ClaudeRunner} for the
 * common case (and for the fake in tests). Triage is ESSENTIAL, so it proceeds even over the throttle.
 */
export async function triageMessage(
  runner: ClaudeRunner,
  message: TriageMessageInput,
  fromState: TaskState,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): Promise<TriageResult> {
  const spec = buildTriageSpec(message, options);
  const result = await runner.run(spec);
  const decision = parseTriageDecision(result);
  const event = dispositionToEvent(decision);
  const transition = event === null ? null : resolveEvent(fromState, event);
  return { decision, event, transition, costUsd: result.costUsd, model: result.model };
}
