/**
 * Locating the editable per-task system-prompt markdown at RUNTIME (PROJECT.md §4: read at runtime
 * so they're tunable without code changes; passed via `--system-prompt-file`).
 *
 * The prompt files live in the repo-root `prompts/` directory (PLAN.md §2 layout). We resolve that
 * directory by walking up from this module's location until we find a `prompts/` dir — robust to
 * being run from `src` (vitest/tsx) or a bundled `dist`. `CLAUDE_PROMPTS_DIR` overrides it entirely
 * (e.g. a packaged install pointing at a user-config location).
 *
 * This module only RESOLVES paths (and verifies existence); the runner passes them to `claude`,
 * which reads the file itself. We never read the prompt CONTENT here.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Known prompt files (PLAN.md §2). Phase 4 ships `triage` + `summarize`; the rest land later. */
export const PROMPT_FILES = {
  triage: 'triage.md',
  'extract-promises': 'extract-promises.md',
  summarize: 'summarize.md',
  draft: 'draft.md',
  digest: 'digest.md',
  nudge: 'nudge.md',
} as const;

export type PromptName = keyof typeof PROMPT_FILES;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from `start` looking for a `prompts/` directory; return its absolute path or `null`. */
function findPromptsDirFrom(start: string): string | null {
  let dir = start;
  // Bounded walk to the filesystem root.
  for (;;) {
    const candidate = path.join(dir, 'prompts');
    if (isDir(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

let cachedDir: string | undefined;

/**
 * The absolute path to the `prompts/` directory. `CLAUDE_PROMPTS_DIR` wins; otherwise discovered by
 * walking up from this module. Cached after first resolution. Throws if it cannot be found (a clear
 * failure beats silently passing a missing `--system-prompt-file`).
 */
export function promptsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_PROMPTS_DIR;
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  if (cachedDir !== undefined) {
    return cachedDir;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = findPromptsDirFrom(here);
  if (found === null) {
    throw new Error(
      `could not locate the prompts/ directory walking up from ${here}; set CLAUDE_PROMPTS_DIR`,
    );
  }
  cachedDir = found;
  return found;
}

/** Absolute path to a known prompt markdown file, verifying it exists (it is read by `claude`). */
export function promptPath(name: PromptName, env: NodeJS.ProcessEnv = process.env): string {
  const file = path.join(promptsDir(env), PROMPT_FILES[name]);
  if (!existsSync(file)) {
    throw new Error(`prompt file not found: ${file} (expected the editable ${name} system prompt)`);
  }
  return file;
}

/** Reset the cached prompts dir — for tests that point `CLAUDE_PROMPTS_DIR` around. */
export function resetPromptsDirCache(): void {
  cachedDir = undefined;
}
