/**
 * The FAKE Claude runner — returns canned {@link JobResult}s with NO API call, so ALL downstream
 * logic (triage→state mapping, summarize, budget backpressure, the queue) is testable deterministic
 * (PROJECT.md §4 "job runner notes"; PLAN.md §5 "fake runner"). This is load-bearing for tests.
 *
 * Two configuration modes, combinable:
 *  - a per-`taskKind` MAP of canned results (matched first), and
 *  - a QUEUE of results consumed in order (fallback when no map entry matches).
 * It also records every {@link JobSpec} it received (`calls`) so a test can assert what was asked —
 * the argv that WOULD be built, the model, the schema, etc.
 */
import type { TaskKind } from '@mailordomo/shared';
import { modelForTask } from '@mailordomo/shared';
import { buildClaudeArgs } from './build-args';
import type { ClaudeRunner, JobResult, JobSpec } from './types';

/** A canned result, or a factory computing one from the incoming spec (for dynamic fakes). */
export type FakeResponse = Partial<JobResult> | ((spec: JobSpec) => Partial<JobResult>);

export interface FakeRunnerConfig {
  /** Matched first, by `spec.taskKind`. A function receives the spec. */
  readonly byKind?: Partial<Record<TaskKind, FakeResponse>>;
  /** Consumed in order when no `byKind` entry matches. */
  readonly queue?: readonly FakeResponse[];
  /** Used when neither a map entry nor a queued response is available. */
  readonly fallback?: FakeResponse;
}

/** A complete default `JobResult`; overrides from the configured `FakeResponse` are merged on top. */
function baseResult(spec: JobSpec): JobResult {
  return {
    text: '',
    model: modelForTask(spec.taskKind),
    costUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    isError: false,
    sessionId: `fake-${spec.taskKind}`,
    numTurns: 1,
    durationMs: 0,
  };
}

function resolveResponse(response: FakeResponse, spec: JobSpec): Partial<JobResult> {
  return typeof response === 'function' ? response(spec) : response;
}

export class FakeClaudeRunner implements ClaudeRunner {
  /** Every spec the runner was asked to run, in order (for assertions). */
  readonly calls: JobSpec[] = [];
  /** The argv that `buildClaudeArgs` produced per call — handy to assert flag assembly end-to-end. */
  readonly argv: string[][] = [];

  private readonly byKind: Partial<Record<TaskKind, FakeResponse>>;
  private readonly queue: FakeResponse[];
  private readonly fallback: FakeResponse | undefined;

  constructor(config: FakeRunnerConfig = {}) {
    this.byKind = config.byKind ?? {};
    this.queue = [...(config.queue ?? [])];
    this.fallback = config.fallback;
  }

  run(spec: JobSpec): Promise<JobResult> {
    this.calls.push(spec);
    this.argv.push(buildClaudeArgs(spec));

    const mapped = this.byKind[spec.taskKind];
    const chosen: FakeResponse | undefined = mapped ?? this.queue.shift() ?? this.fallback;

    const overrides = chosen === undefined ? {} : resolveResponse(chosen, spec);
    return Promise.resolve({ ...baseResult(spec), ...overrides });
  }
}
