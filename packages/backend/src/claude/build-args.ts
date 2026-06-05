/**
 * PURE argv assembly for a `claude` invocation — no spawning, no IO. Unit-testable on its own (the
 * separate test author asserts the exact argv for representative specs). The spawn glue in
 * `runner.ts` calls this and pipes the prompt over stdin; this function NEVER puts the prompt in the
 * argv (golden rule #5 statelessness + ARG_MAX avoidance — the large prompt goes via stdin).
 *
 * Every flag here is CONFIRMED to exist on `claude` v2.1.165 (PROJECT.md §4 verified table):
 *   -p / --print              headless one-shot
 *   --output-format json      cost/usage/structured-output envelope
 *   --model <alias>           fixed routing (haiku/sonnet/opus) — from `modelForTask(taskKind)`
 *   --system-prompt-file      editable per-task prompt
 *   --append-system-prompt-file   layered tone-memory file
 *   --json-schema <json>      schema-constrained `structured_output`
 *   --permission-mode dontAsk + --allowedTools   non-hanging read-only jobs
 *   --add-dir <dir>           repo-aware reads
 *   --bare                    skip hook/plugin discovery
 */
import type { ModelAlias } from '@mailordomo/shared';
import { modelForTask } from '@mailordomo/shared';
import type { JobSpec } from './types';

/**
 * The default permission mode for every daemon job: `dontAsk` never blocks on an interactive
 * prompt (PROJECT.md §4 — `default`/`plan` would hang a headless run). Confirmed valid on the CLI.
 */
export const DEFAULT_PERMISSION_MODE = 'dontAsk' as const;

/** Build the argv array for a job (excluding the leading `claude` program name). */
export function buildClaudeArgs(spec: JobSpec): string[] {
  const model: ModelAlias = modelForTask(spec.taskKind);

  // `-p` headless + JSON envelope + fixed-routed model are always present.
  const args: string[] = ['-p', '--output-format', 'json', '--model', model];

  // Never block a headless daemon job on an interactive permission prompt.
  args.push('--permission-mode', DEFAULT_PERMISSION_MODE);

  if (spec.systemPromptFile !== undefined) {
    args.push('--system-prompt-file', spec.systemPromptFile);
  }
  if (spec.appendSystemPromptFile !== undefined) {
    args.push('--append-system-prompt-file', spec.appendSystemPromptFile);
  }
  if (spec.jsonSchema !== undefined) {
    // Serialize the schema object to the single string argv `--json-schema` expects.
    args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  }

  // Repo-aware reads: scope the job to explicit dirs, with the allowed tool set.
  for (const dir of spec.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (spec.allowedTools !== undefined && spec.allowedTools.length > 0) {
    // CLI takes a single space-separated string, e.g. --allowedTools "Read".
    args.push('--allowedTools', spec.allowedTools.join(' '));
  }

  if (spec.bare === true) {
    args.push('--bare');
  }

  return args;
}

/** The model alias a spec runs under — exposed for logging/metrics without re-deriving routing. */
export function modelAliasForSpec(spec: JobSpec): ModelAlias {
  return modelForTask(spec.taskKind);
}
