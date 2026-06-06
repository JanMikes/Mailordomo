/**
 * Morning-digest consumer (PROJECT.md §9, §5; PLAN.md D34) — two halves, both privacy-load-bearing:
 *
 *  1. `assembleDigestMetadata(input, window)` — a PURE, body-free assembler (no IO, no wall clock)
 *     that turns metadata the local app already read from the service into the shared
 *     {@link DigestMetadata} read model: `needs_you` (tasks needing my action joined to their thread),
 *     `promises_due` (open/overdue commitments due by the window end), `handled` (actor-attributed
 *     transitions in the window — the "what Simona handled" feed), and `drafted` (draft METADATA in
 *     the window). It mirrors the server's `getDigestMetadata` selection but in-memory, so the local
 *     app fully controls assembly and the prose stays local. Body-free BY CONSTRUCTION — it only ever
 *     reads the sanctioned subject/snippet/sender + state/promise/draft/transition metadata.
 *
 *  2. `synthesizeDigest(runner, metadata, ...)` — a SONNET synthesis of that body-free metadata into
 *     prose, run LOCALLY (Golden rule #3: my-mailbox content is synthesized on this machine; nothing
 *     body-ful crosses to the server). `digest` routes to Sonnet via the shared map and is a
 *     DEFERRABLE kind (the usage throttle backpressures it; see `throttle.ts`).
 *
 * PRIVACY (Golden rule #3): the "handled"/Simona section is built ONLY from actor-attributed
 * transitions (subject + actor — server metadata), never her body. The prompt is rendered from the
 * body-free metadata, so the synthesis cannot leak a body even though the model runs locally.
 */
import type {
  DigestDraftEntry,
  DigestMetadata,
  DigestPromiseEntry,
  DigestThreadRef,
  DigestTransitionEntry,
  DraftMeta,
  PromiseRecord,
  Task,
  TaskState,
  Thread,
} from '@mailordomo/shared';
import { promptPath } from './prompts';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** Task states whose ball is in MY court → "what needs you today" (mirrors the server's selection). */
const NEEDS_YOU_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['needs-reply', 'follow-up']);

/** Promise statuses that are still actionable (count toward "promises due"). */
function isActionable(status: PromiseRecord['status']): boolean {
  return status === 'open' || status === 'overdue';
}

/** The metadata the digest assembler reasons over — exactly what the endpoint reads from the service. */
export interface DigestAssemblyInput {
  /** The configured single Today/digest project (D29). */
  readonly projectId: string;
  readonly tasks: readonly Task[];
  readonly threads: readonly Thread[];
  readonly promises: readonly PromiseRecord[];
  readonly draftMeta: readonly DraftMeta[];
  /**
   * Actor-attributed task transitions for the window — the body-free "what was handled" feed
   * (`MetadataClient.listTransitionsInWindow`). Already windowed by the read; re-filtered defensively
   * here so the pure function is a total function of its inputs.
   */
  readonly transitions: readonly DigestTransitionEntry[];
  /** ISO-8601 instant the digest was generated. Defaults to `window.end`. */
  readonly generatedAtIso?: string;
}

/** The inclusive time window the digest covers (a morning digest typically spans the prior day). */
export interface DigestWindow {
  readonly start: string;
  readonly end: string;
}

/** True iff `iso` parses and falls within `[startMs, endMs]` (inclusive). Unparseable ⇒ excluded. */
function inWindow(iso: string | null, startMs: number, endMs: number): boolean {
  if (iso === null) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t <= endMs;
}

/** Compare two nullable ISO strings ascending; nulls sort last. */
function byIsoAsc(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return Date.parse(a) - Date.parse(b);
}

/** Compare two ISO strings descending (newest first). */
function byIsoDesc(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

/**
 * PURE: assemble the body-free {@link DigestMetadata} for `window` from already-read metadata. No IO,
 * no wall clock. Mirrors `server/repo/sqlite.ts#getDigestMetadata` (the local app assembles its own
 * copy so the prose synthesis can stay local). Strict-schema-shaped by construction.
 */
export function assembleDigestMetadata(
  input: DigestAssemblyInput,
  window: DigestWindow,
): DigestMetadata {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));

  // "What needs you today": tasks needing my action, joined to a known thread, newest-updated first.
  const needsYouRanked: { ref: DigestThreadRef; updatedAt: string }[] = [];
  for (const task of input.tasks) {
    if (!NEEDS_YOU_STATES.has(task.state)) continue;
    const thread = threadsById.get(task.thread_id);
    if (thread === undefined) continue; // no thread context → cannot render a body-free row
    needsYouRanked.push({
      updatedAt: task.updated_at,
      ref: {
        thread_id: thread.id,
        project_id: thread.project_id,
        subject: thread.subject,
        snippet: thread.snippet,
        sender: thread.sender,
        state: task.state,
        importance: task.importance,
        deadline: task.deadline,
      },
    });
  }
  needsYouRanked.sort((a, b) => byIsoDesc(a.updatedAt, b.updatedAt));
  const needsYou: DigestThreadRef[] = needsYouRanked.map((entry) => entry.ref);

  // "Promises due": still-open/overdue commitments with a resolved deadline at/before the window end.
  const promisesDue: DigestPromiseEntry[] = [];
  for (const promise of input.promises) {
    if (!isActionable(promise.status)) continue;
    if (promise.due_at === null) continue;
    const due = Date.parse(promise.due_at);
    if (Number.isNaN(due) || due > endMs) continue;
    const thread = threadsById.get(promise.thread_id);
    promisesDue.push({
      promise_id: promise.id,
      thread_id: promise.thread_id,
      subject: thread?.subject ?? '',
      direction: promise.direction,
      text: promise.text,
      due_at: promise.due_at,
      status: promise.status,
    });
  }
  promisesDue.sort((a, b) => byIsoAsc(a.due_at, b.due_at));

  // "What was handled": actor-attributed transitions in the window (defensively re-filtered), newest first.
  const handled: DigestTransitionEntry[] = input.transitions
    .filter((t) => inWindow(t.at, startMs, endMs))
    .slice()
    .sort((a, b) => byIsoDesc(a.at, b.at));

  // "What Claude drafted": draft METADATA (no body) timestamped within the window, newest first.
  const drafted: DigestDraftEntry[] = [];
  for (const draft of input.draftMeta) {
    if (!inWindow(draft.at, startMs, endMs)) continue;
    const thread = threadsById.get(draft.thread_id);
    drafted.push({
      thread_id: draft.thread_id,
      subject: thread?.subject ?? '',
      model: draft.model,
      author: draft.author,
      at: draft.at,
    });
  }
  drafted.sort((a, b) => byIsoDesc(a.at, b.at));

  return {
    project_id: input.projectId,
    generated_at: input.generatedAtIso ?? window.end,
    window_start: window.start,
    window_end: window.end,
    needs_you: needsYou,
    promises_due: promisesDue,
    handled,
    drafted,
  };
}

/* --------------------------- Sonnet prose synthesis --------------------------- */

/** Render a single "needs you" line from body-free fields only. */
function needsYouLine(ref: DigestThreadRef): string {
  const due = ref.deadline === null ? '' : ` (due ${ref.deadline})`;
  return `- [${ref.state}, importance ${ref.importance}] ${ref.subject} — from ${ref.sender}${due}`;
}

/**
 * Render the digest synthesis prompt from the body-free {@link DigestMetadata}. Uses ONLY sanctioned
 * metadata (subject/snippet/sender + state/promise/draft/transition fields), so the prompt — and
 * therefore the local synthesis — cannot carry a message body.
 */
export function renderDigestPrompt(metadata: DigestMetadata): string {
  const lines: string[] = [
    'Write a short, warm morning digest for me from the structured metadata below.',
    'Group it into: what needs me today, promises due, what was handled (by whom), and what Claude drafted.',
    'Be concise; do not invent details beyond the metadata.',
    '',
    `Window: ${metadata.window_start} → ${metadata.window_end}`,
    '',
    `## What needs you today (${metadata.needs_you.length})`,
    ...metadata.needs_you.map(needsYouLine),
    '',
    `## Promises due (${metadata.promises_due.length})`,
    ...metadata.promises_due.map(
      (p) =>
        `- [${p.direction}, ${p.status}] ${p.text} — re: ${p.subject}${p.due_at ? ` (due ${p.due_at})` : ''}`,
    ),
    '',
    `## What was handled (${metadata.handled.length})`,
    ...metadata.handled.map(
      (h) => `- ${h.actor} moved "${h.subject}" ${h.from} → ${h.to} at ${h.at}`,
    ),
    '',
    `## What Claude drafted (${metadata.drafted.length})`,
    ...metadata.drafted.map((d) => `- draft for "${d.subject}" (${d.model}) at ${d.at}`),
  ];
  return lines.join('\n');
}

/**
 * PURE: build the digest {@link JobSpec}. `taskKind: 'digest'` routes to SONNET via the shared map;
 * the system prompt is the editable `digest.md`. No `--json-schema`: the digest is prose (`result`).
 */
export function buildDigestSpec(
  metadata: DigestMetadata,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'digest',
    prompt: renderDigestPrompt(metadata),
    systemPromptFile: promptPath('digest'),
    allowedTools: ['Read'],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** The synthesized digest: the prose + cost/model of the underlying Sonnet call. */
export interface DigestSynthesis {
  readonly prose: string;
  readonly costUsd: number;
  readonly model: string;
}

/** Extract the prose from a completed digest job (throws on an error envelope or empty result). */
export function parseDigestProse(result: JobResult): DigestSynthesis {
  if (result.isError) {
    throw new Error(
      `digest job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  const prose = result.text.trim();
  if (prose === '') {
    throw new Error('digest job returned empty prose');
  }
  return { prose, costUsd: result.costUsd, model: result.model };
}

/**
 * Run the digest synthesis end-to-end through the runner seam (pass the FAKE in tests). DEFERRABLE —
 * the caller should gate this on the usage throttle (the digest yields to essential triage when the
 * subscription window is hot). Returns the prose + accounting.
 */
export async function synthesizeDigest(
  runner: ClaudeRunner,
  metadata: DigestMetadata,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): Promise<DigestSynthesis> {
  const spec = buildDigestSpec(metadata, options);
  const result = await runner.run(spec);
  return parseDigestProse(result);
}
