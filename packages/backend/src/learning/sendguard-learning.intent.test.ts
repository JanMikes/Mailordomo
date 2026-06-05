/**
 * INTENT-DERIVED structural guard for Phase 6 (Golden rule #1 / PLAN.md §4.6): silent learning must
 * have NO import path to the SMTP send module — it runs AFTER a send and may only edit tone markdown +
 * write a changelog. Mirrors the Phase-0 `sendguard.test.ts` pattern (lint in-memory source as if it
 * lived under `learning/`, using the repo's REAL `eslint.config.js`) and extends it to the
 * `learning/** → smtp/**` boundary — static imports, dynamic `import()`, and barrel re-exports — with a
 * positive control proving the guard is not over-broad. Additive to the implementer's smoke suite.
 *
 * MUTATION CHECK (pins "learning can't reach SMTP at lint time"): delete the `learning/**` block from
 * `eslint.config.js` and every `FAILS …` case below goes green-when-it-should-fail. Verified by
 * reasoning against the config's `NO_SEND_FROM_LEARNING` rule.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/backend/src/learning  ->  four levels up is the repo root.
const repoRoot = path.resolve(here, '../../../..');

async function lintAsFile(relPathFromRepoRoot: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const filePath = path.join(repoRoot, relPathFromRepoRoot);
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error('ESLint returned no result');
  return result;
}

/** Violations from either guard rule (static imports or dynamic import/require syntax). */
function guardViolations(result: { messages: { ruleId: string | null }[] }) {
  return result.messages.filter(
    (m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax',
  );
}

const LEARNING_FILE = 'packages/backend/src/learning/__guard_fixture__.ts';

describe('structural no-send guard for learning (Golden rule #1 / PLAN.md §4.6 / Phase 6)', () => {
  it('FAILS when learning code statically imports the SMTP send path', async () => {
    const result = await lintAsFile(
      LEARNING_FILE,
      `import { sendReply } from '../smtp/send';\nexport const x = sendReply;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when learning code DYNAMICALLY imports the SMTP send path', async () => {
    const result = await lintAsFile(
      LEARNING_FILE,
      `export async function load() {\n  return import('../smtp/send');\n}\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when learning code imports the SMTP barrel (re-export hole)', async () => {
    const result = await lintAsFile(
      LEARNING_FILE,
      `import * as smtp from '../smtp';\nexport const x = smtp;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when learning code require()s the SMTP send path', async () => {
    const result = await lintAsFile(LEARNING_FILE, `export const s = require('../smtp/send');\n`);
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('ALLOWS legitimate learning imports (tone store + shared) — the guard is not over-broad', async () => {
    const result = await lintAsFile(
      'packages/backend/src/learning/__guard_fixture_ok__.ts',
      `import { ToneStore } from '../tone/store';\nimport { AUTOMATED_ACTOR } from '@mailordomo/shared';\nexport const ok = [ToneStore, AUTOMATED_ACTOR] as const;\n`,
    );
    expect(guardViolations(result).length).toBe(0);
  });

  it('ALLOWS learning to dynamically import an unrelated module (no false positive)', async () => {
    const result = await lintAsFile(
      'packages/backend/src/learning/__guard_fixture_ok2__.ts',
      `export async function load() {\n  return import('node:crypto');\n}\n`,
    );
    expect(guardViolations(result).length).toBe(0);
  });
});
