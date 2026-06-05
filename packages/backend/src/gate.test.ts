import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Proves the quality gate actually gates (PLAN.md Phase 0 tests): the checks the pre-commit /
 * pre-push hooks run — lint and typecheck — must reject deliberately broken code. We exercise the
 * real checks directly rather than driving git, which keeps the test deterministic and free of
 * side effects on the working tree.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

describe('quality gate actually gates', () => {
  it('lint rejects code with an unused variable', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const [result] = await eslint.lintText('export function f() {\n  const unused = 1;\n}\n', {
      filePath: path.join(repoRoot, 'packages/backend/src/__gate_fixture__.ts'),
    });
    if (!result) throw new Error('ESLint returned no result');
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('typecheck (tsc) rejects a type-broken file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mailordomo-gate-'));
    const file = path.join(dir, 'broken.ts');
    writeFileSync(file, 'export const n: number = "not a number";\n');
    let failed = false;
    try {
      execFileSync('npx', ['tsc', '--noEmit', '--strict', file], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failed).toBe(true);
  });
});
