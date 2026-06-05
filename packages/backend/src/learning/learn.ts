/**
 * The silent-learning ORCHESTRATOR (PROJECT.md §6: "Continuous learning is silent + logged +
 * revertable: Claude updates tone-memory markdown from (a) recurring draft instructions and (b) the
 * diff between its draft and what the user actually sent, writing a changelog the user can review and
 * revert"). This is the thin IO/coordination edge; the deterministic pieces (`signals.ts`) and the
 * schema (`learn-schema.ts`) are pure and tested in isolation.
 *
 * GOLDEN RULES honored here:
 *  - #1 (sending is always manual): learning runs AFTER a send and has NO reference to any send path —
 *    it only edits tone markdown + writes a changelog. The ESLint guard additionally bars `learning/**`
 *    from importing anything under `smtp/**` (defense in depth). This module imports no transmit code.
 *  - #3 (bodies never leave): the ONLY thing posted to the server is the one-line `summary`
 *    (`createLearningEntry`). The draft/sent bodies, the diff, and the before/after tone snapshots stay
 *    LOCAL (the snapshots live in the {@link LearningLog} for revert).
 *  - #6 (routing): the `learn` job routes to SONNET (internal analysis, not outgoing text) via the
 *    shared map — the spec never names a model.
 *
 * Dependencies are INJECTED (runner / tone store / learning log / a narrow metadata client) so the
 * whole flow is testable with the fake runner + an in-process server, with no live API.
 */
import type {
  Actor,
  CreateLearningEntryRequest,
  LearningEntry,
  ProjectId,
  ToneFile,
  ToneScope,
} from '@mailordomo/shared';
import { AUTOMATED_ACTOR } from '@mailordomo/shared';
import { promptPath } from '../claude/prompts';
import type { ClaudeRunner, JobResult, JobSpec } from '../claude/types';
import type { ToneStore } from '../tone/store';
import { LEARN_JSON_SCHEMA, LearnOutputSchema } from './learn-schema';
import type { LearnOutput } from './learn-schema';
import type { LearningLog } from './log';
import type { DiffSummary } from './signals';
import { renderDiffSummary } from './signals';

/** The learning signal to summarize: a recurring draft instruction OR a draft-vs-sent diff. */
export type LearnSignal =
  | { readonly type: 'recurring-instruction'; readonly instruction: string }
  | { readonly type: 'draft-vs-sent'; readonly diff: DiffSummary };

/** Which tone file a learned lesson updates. */
export interface LearnTarget {
  readonly projectId: ProjectId;
  readonly scope: ToneScope;
  /** Stable tone-file path within the project (e.g. `contact/jan@acme.com.md`). */
  readonly path: string;
}

/** The narrow metadata slice the orchestrator needs (the real {@link MetadataClient} satisfies it). */
export interface LearningMetadataClient {
  createLearningEntry(req: CreateLearningEntryRequest): Promise<LearningEntry>;
  revertLearningEntry(id: string): Promise<LearningEntry>;
}

/** Injected collaborators for the learning flow. */
export interface LearningDeps {
  readonly runner: ClaudeRunner;
  readonly store: ToneStore;
  readonly log: LearningLog;
  readonly metadata: LearningMetadataClient;
}

/** Per-call context: the injected "now" (a tone write stamps a fresh `updated_at`) + the actor. */
export interface LearnContext {
  /** ISO-8601 "now" — INJECTED (no `Date.now()` on this path). */
  readonly now: string;
  /** Actor attributed with the tone write; defaults to the daemon ({@link AUTOMATED_ACTOR}). */
  readonly updatedBy?: Actor;
}

/* -------------------------------------------------------------------------- */
/* PURE helpers                                                                */
/* -------------------------------------------------------------------------- */

/** PURE: render the `learn` user prompt (over stdin) from a signal + scope. Deterministic for fixtures. */
export function renderLearnPrompt(signal: LearnSignal, scope: ToneScope): string {
  const lines = [
    `Derive a durable tone/voice lesson for the "${scope}" scope from the signal below.`,
    '',
  ];
  if (signal.type === 'recurring-instruction') {
    lines.push(
      'Signal type: recurring draft instruction (the user has typed this guidance more than once).',
      '',
      'Instruction:',
      signal.instruction,
    );
  } else {
    lines.push(
      'Signal type: draft-vs-sent diff ("-" lines were in my draft; "+" lines are what the user sent).',
      '',
      'Diff:',
      renderDiffSummary(signal.diff),
    );
  }
  return lines.join('\n');
}

/**
 * PURE: build the `learn` {@link JobSpec}. `taskKind: 'learn'` routes to SONNET via the shared map; the
 * system prompt is the editable `learn.md`; `--json-schema` constrains the `{tone_update, summary}`
 * output. Read-only tools — learning never needs to write anything through `claude`.
 */
export function buildLearnSpec(
  signal: LearnSignal,
  scope: ToneScope,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): JobSpec {
  return {
    taskKind: 'learn',
    prompt: renderLearnPrompt(signal, scope),
    systemPromptFile: promptPath('learn'),
    jsonSchema: LEARN_JSON_SCHEMA,
    allowedTools: ['Read'],
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bare !== undefined ? { bare: options.bare } : {}),
  };
}

/** Validate the runner's `structured_output` into a {@link LearnOutput} (throws on error/bad shape). */
export function parseLearnOutput(result: JobResult): LearnOutput {
  if (result.isError) {
    throw new Error(
      `learn job failed (api_error_status=${result.apiErrorStatus ?? 'unknown'}): ${result.text}`,
    );
  }
  return LearnOutputSchema.parse(result.structuredOutput);
}

/**
 * PURE: append a learned lesson to the existing tone-file content. The lesson is GUIDANCE (a sentence
 * or two), appended as a new paragraph; an empty file becomes just the lesson. This is an APPEND, not a
 * field merge — it is editing one markdown document, never reconciling two stores (Golden rule #2).
 */
export function appendLesson(existing: string, lesson: string): string {
  const base = existing.trim();
  const next = lesson.trim();
  if (next === '') return base;
  if (base === '') return next;
  return `${base}\n\n${next}`;
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                               */
/* -------------------------------------------------------------------------- */

/** The outcome of applying a learned lesson. */
export interface LearningApplied {
  /** The server-recorded changelog entry (summary only crossed the boundary). */
  readonly entry: LearningEntry;
  /** The updated local tone file (fresh `version_hash` + `updated_at`). */
  readonly toneFile: ToneFile;
  /** The lesson text appended to the tone file. */
  readonly toneUpdate: string;
  /** The one-line changelog summary. */
  readonly summary: string;
  /** Notional usage for the `learn` call (throttle signal; not a dollar charge). */
  readonly costUsd: number;
  readonly model: string;
}

/**
 * Apply a learned lesson end-to-end:
 *  1. run the SONNET `learn` job (`--json-schema`) → `{tone_update, summary}`;
 *  2. APPEND `tone_update` into the scoped tone file, capturing before/after content LOCALLY;
 *  3. record the changelog: `createLearningEntry` on the server (SUMMARY ONLY) + a local record with
 *     the before/after snapshots (for revert).
 * Returns the applied result. Pass the FAKE runner + an in-process server in tests for determinism.
 */
export async function applyLearning(
  deps: LearningDeps,
  target: LearnTarget,
  signal: LearnSignal,
  ctx: LearnContext,
  options: { readonly timeoutMs?: number; readonly bare?: boolean } = {},
): Promise<LearningApplied> {
  const spec = buildLearnSpec(signal, target.scope, options);
  const result = await deps.runner.run(spec);
  const output = parseLearnOutput(result);

  // Apply to the tone file, capturing the before/after snapshots locally (for revert).
  const before = deps.store.read(target.path)?.content ?? '';
  const after = appendLesson(before, output.tone_update);
  const updatedBy = ctx.updatedBy ?? AUTOMATED_ACTOR;
  const toneFile = deps.store.write({
    scope: target.scope,
    path: target.path,
    content: after,
    updated_by: updatedBy,
    updated_at: ctx.now,
  });

  // Record the changelog: server gets the SUMMARY ONLY; the snapshots stay local.
  const entry = await deps.metadata.createLearningEntry({
    project_id: target.projectId,
    scope: target.scope,
    summary: output.summary,
  });
  deps.log.append({
    id: entry.id,
    project_id: target.projectId,
    scope: target.scope,
    path: target.path,
    summary: output.summary,
    before_content: before,
    after_content: after,
    applied_at: entry.applied_at,
    reverted_at: null,
  });

  return {
    entry,
    toneFile,
    toneUpdate: output.tone_update,
    summary: output.summary,
    costUsd: result.costUsd,
    model: result.model,
  };
}

/**
 * Revert a learned lesson by its (server) id: restore the tone file's BEFORE content from the local
 * snapshot (a whole-file local edit that LWW sync will propagate), then flip the server changelog flag
 * (`revertLearningEntry`, idempotent). Idempotent overall — re-reverting an already-reverted entry
 * skips the (already-applied) content restore but still confirms the server flag.
 *
 * NOTE: revert restores the snapshot captured WHEN THIS lesson was applied; reverting lessons out of
 * the order they were applied can therefore drop later lessons (snapshot semantics, not field merge).
 */
export async function revertLearning(
  deps: LearningDeps,
  id: string,
  ctx: LearnContext,
): Promise<LearningEntry> {
  const record = deps.log.get(id);
  if (record === undefined) {
    throw new Error(`cannot revert unknown learning entry: ${id}`);
  }

  if (record.reverted_at === null) {
    deps.store.write({
      scope: record.scope,
      path: record.path,
      content: record.before_content,
      updated_by: ctx.updatedBy ?? AUTOMATED_ACTOR,
      updated_at: ctx.now,
    });
  }

  const entry = await deps.metadata.revertLearningEntry(id);
  deps.log.markReverted(id, entry.reverted_at ?? ctx.now);
  return entry;
}
