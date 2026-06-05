/**
 * PURE parse of `claude --output-format json` stdout → a normalized {@link JobResult} — no IO. This
 * is the seam the recorded fixtures replay through (PLAN.md §4.8): a test feeds a checked-in golden
 * envelope here and asserts the mapping, with NO live call.
 *
 * Defensive on purpose: the runner must surface a usable result (or a clear error) even if a field
 * is missing or the model id can't be read from `modelUsage`. Numeric fields default to 0; the
 * model id falls back to the requested alias the caller passes in.
 */
import type { ClaudeJsonEnvelope, JobResult, JobUsage } from './types';

/** Thrown when stdout is not the JSON envelope at all (e.g. the CLI crashed before emitting it). */
export class ClaudeParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ClaudeParseError';
  }
}

/** Pick the full model id from `modelUsage` (its single key), or fall back to the requested alias. */
function resolveModelId(envelope: ClaudeJsonEnvelope, fallbackAlias: string): string {
  const usage = envelope.modelUsage;
  if (usage) {
    const keys = Object.keys(usage);
    const first = keys[0];
    if (first !== undefined) {
      return first;
    }
  }
  return fallbackAlias;
}

function normalizeUsage(envelope: ClaudeJsonEnvelope): JobUsage {
  const u = envelope.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    ...(u.service_tier !== undefined ? { serviceTier: u.service_tier } : {}),
  };
}

/**
 * Parse a raw envelope OBJECT (already JSON-decoded) into a {@link JobResult}. `fallbackAlias` is
 * the model alias the runner asked for, used only when `modelUsage` is empty.
 */
export function envelopeToJobResult(
  envelope: ClaudeJsonEnvelope,
  fallbackAlias: string,
): JobResult {
  const apiErrorStatus = envelope.api_error_status;
  return {
    ...(envelope.structured_output !== undefined
      ? { structuredOutput: envelope.structured_output }
      : {}),
    text: envelope.result ?? '',
    model: resolveModelId(envelope, fallbackAlias),
    costUsd: envelope.total_cost_usd ?? 0,
    usage: normalizeUsage(envelope),
    isError: envelope.is_error === true,
    ...(apiErrorStatus !== undefined && apiErrorStatus !== null ? { apiErrorStatus } : {}),
    sessionId: envelope.session_id ?? '',
    numTurns: envelope.num_turns ?? 0,
    durationMs: envelope.duration_ms ?? 0,
  };
}

/**
 * Parse raw STDOUT text from `claude --output-format json` into a {@link JobResult}.
 * Throws {@link ClaudeParseError} if stdout is not valid JSON. `fallbackAlias` defaults to the
 * empty string; callers (the runner) pass the requested alias so the model id is never blank.
 */
export function parseClaudeJson(stdout: string, fallbackAlias = ''): JobResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new ClaudeParseError('claude produced no stdout to parse', stdout);
  }
  let envelope: ClaudeJsonEnvelope;
  try {
    envelope = JSON.parse(trimmed) as ClaudeJsonEnvelope;
  } catch (cause) {
    throw new ClaudeParseError(
      `claude stdout was not valid --output-format json: ${(cause as Error).message}`,
      stdout,
    );
  }
  return envelopeToJobResult(envelope, fallbackAlias);
}
