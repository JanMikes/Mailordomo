/**
 * Claude job-runner contracts — the shapes that flow through the runner, the queue, and the two
 * consumers (triage, summarize). Kept free of any runtime import so the pure seams
 * (`buildClaudeArgs`, `parseClaudeJson`) and the fake runner can depend on the shapes without
 * dragging in `node:child_process`.
 *
 * GROUND TRUTH (verified against `claude` v2.1.165 on this machine; PROJECT.md §4): each call is the
 * headless binary `claude -p` (golden rule #5, stateless — no `--continue`/`--resume`), with
 * `--output-format json`, the model from the routing map, optional `--system-prompt-file` +
 * `--append-system-prompt-file` (layered tone), optional `--json-schema` (→ `structured_output`),
 * and optional `--add-dir`/`--allowedTools` for repo-aware reads.
 */
import type { ModelAlias, TaskKind } from '@mailordomo/shared';

/**
 * One unit of work for the runner. `taskKind` is what DRIVES the model (via the shared
 * `MODEL_ROUTING` map) — the spec never names a model directly, so golden rule #6 cannot be
 * violated by a caller. Everything else is optional and maps 1:1 onto a verified `claude` flag.
 */
export interface JobSpec {
  /** Drives the model via `modelForTask(taskKind)`; also classifies the job for budget policy. */
  readonly taskKind: TaskKind;
  /**
   * The user prompt. Passed to `claude` via STDIN (not argv) so a large prompt dodges ARG_MAX
   * (PROJECT.md: stdin capped ~10 MB). Bodies are read LOCALLY — the runner runs on this machine.
   */
  readonly prompt: string;
  /** `--system-prompt-file` — the editable per-task system prompt (markdown under `prompts/`). */
  readonly systemPromptFile?: string;
  /** `--append-system-prompt-file` — a layered tone-memory file appended onto the system prompt. */
  readonly appendSystemPromptFile?: string;
  /**
   * `--json-schema` — a JSON Schema object. When present, the model's answer is schema-constrained
   * and returned in `structured_output` (used for triage; no fragile free-text parsing).
   */
  readonly jsonSchema?: unknown;
  /** `--add-dir <dir>` (repeatable) — directories a repo-aware read job may reach. */
  readonly addDirs?: readonly string[];
  /** `--allowedTools` — e.g. `["Read"]` for a read-only repo job. */
  readonly allowedTools?: readonly string[];
  /** Hang-guard budget in ms (enforced IN NODE — macOS has no `timeout` binary). */
  readonly timeoutMs?: number;
  /** `--bare` — skip hook/plugin discovery for a clean headless run (open Q #30). */
  readonly bare?: boolean;
}

/** Token accounting from the `--output-format json` envelope's `usage` block. */
export interface JobUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly serviceTier?: string;
}

/**
 * The normalized result of one `claude` call. `parseClaudeJson` produces this from the raw
 * envelope; the fake runner returns it directly. `structuredOutput` is populated only when the spec
 * carried a `jsonSchema`. `text` is the envelope's `result` (the free-text answer / summary).
 */
export interface JobResult {
  /** Schema-constrained object when `--json-schema` was used; otherwise `undefined`. */
  readonly structuredOutput?: unknown;
  /** The free-text `result` (empty string when the model only produced structured output). */
  readonly text: string;
  /** Full model id actually used (from `modelUsage`, e.g. `claude-haiku-4-5-20251001`). */
  readonly model: string;
  /**
   * The envelope's `total_cost_usd` for this call, kept as a NOTIONAL USAGE signal — a proxy for how
   * much of the subscription window this call consumed (~proportional to tokens). Under the user's
   * Claude subscription it is NOT a real dollar charge; the {@link UsageThrottle} accumulates it over a
   * rolling window as backpressure on background jobs. (Field name mirrors the binary's output.)
   */
  readonly costUsd: number;
  readonly usage: JobUsage;
  /** Mirrors the envelope `is_error`. */
  readonly isError: boolean;
  /** `api_error_status` (HTTP-ish status) when the call failed upstream; else `undefined`. */
  readonly apiErrorStatus?: number;
  readonly sessionId: string;
  readonly numTurns: number;
  readonly durationMs: number;
}

/**
 * The raw top-level shape of `claude --output-format json` (the captured ground-truth sample lives
 * at `__fixtures__/llm/`). Only the fields the runner consumes are typed; the rest are tolerated.
 * `usage` and `modelUsage` are partial because not every field is load-bearing.
 */
export interface ClaudeJsonEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly api_error_status?: number | null;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly result?: string;
  readonly stop_reason?: string;
  readonly session_id?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly service_tier?: string;
  };
  /** Keyed by full model id (e.g. `claude-haiku-4-5-20251001`). */
  readonly modelUsage?: Record<string, { readonly costUSD?: number } | undefined>;
  readonly structured_output?: unknown;
  readonly uuid?: string;
}

/**
 * The runner interface. The REAL impl spawns `claude`; the FAKE returns canned `JobResult`s so ALL
 * downstream logic (triage→state, summarize, budget backpressure) is testable with no API. This
 * interface is the seam the whole engine is built behind (PROJECT.md §4 "job runner notes").
 */
export interface ClaudeRunner {
  run(spec: JobSpec): Promise<JobResult>;
}

/** Resolve the model alias a spec will run under (pure; used by args build + logging). */
export type { ModelAlias };
