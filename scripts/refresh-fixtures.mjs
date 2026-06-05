#!/usr/bin/env node
/**
 * Regenerate recorded LLM fixtures by making LIVE `claude` calls (PLAN.md §4.8).
 *
 * This script is the ONLY place live Claude calls are allowed. Tests and CI ALWAYS replay the
 * checked-in fixtures under `packages/**\/__fixtures__/llm/` and never call live. A fixture diff in a
 * commit therefore signals "the model output shifted" — an explicit, reviewable act, not a silent
 * test change. The verify gate does NOT run this script.
 *
 * What it does (Phase 4 fixtures: triage + summarize):
 *   1. Builds the SAME argv the real runner builds (`-p --output-format json --model <alias>
 *      --permission-mode dontAsk --system-prompt-file <prompt> [--json-schema <schema>]
 *      --allowedTools Read`), feeding a representative prompt over STDIN.
 *   2. Captures the raw JSON envelope.
 *   3. Writes it to the fixture `.ts` module with the §4.8 header (model alias, prompt-file sha256,
 *      capture date), preserving the `ClaudeJsonEnvelope` import.
 *
 * Usage:  node scripts/refresh-fixtures.mjs            # regenerate all Phase 4 fixtures
 *         node scripts/refresh-fixtures.mjs triage     # just one
 *
 * It deliberately does NOT import the backend TS (no build step needed to refresh fixtures); the
 * argv assembly is mirrored here in miniature, the same way `verify-mailbox.ts` mirrors its engines.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const promptsDir = path.join(repoRoot, 'prompts');
const fixturesDir = path.join(
  repoRoot,
  'packages',
  'backend',
  'src',
  'claude',
  '__fixtures__',
  'llm',
);

// The triage JSON schema must match packages/backend/src/claude/triage-schema.ts (TRIAGE_JSON_SCHEMA).
const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'needs_reply', 'importance', 'confidence', 'reason'],
  properties: {
    disposition: { type: 'string', enum: ['needs-reply', 'no-reply-needed', 'fyi'] },
    needs_reply: { type: 'boolean' },
    importance: { type: 'string', enum: ['high', 'normal', 'low'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
};

/** The fixtures this script knows how to regenerate. */
const JOBS = {
  triage: {
    constName: 'TRIAGE_FIXTURE',
    label: 'TRIAGE',
    file: 'triage.fixture.ts',
    promptFile: 'triage.md',
    modelAlias: 'haiku',
    jsonSchema: TRIAGE_JSON_SCHEMA,
    schemaNote: 'TRIAGE_JSON_SCHEMA (disposition/needs_reply/importance/confidence/reason)',
    userPrompt: [
      'Classify the following email for a task-oriented inbox.',
      '',
      'From: ops-alerts@acme.example',
      'Subject: [PROD] Checkout 500s spiking for EU customers',
      '',
      'Snippet:',
      'We are seeing a spike in HTTP 500s on checkout for EU customers since 09:12. Can you take a look and confirm you are on it?',
    ].join('\n'),
  },
  summarize: {
    constName: 'SUMMARIZE_FIXTURE',
    label: 'SUMMARIZE',
    file: 'summarize.fixture.ts',
    promptFile: 'summarize.md',
    modelAlias: 'sonnet',
    jsonSchema: undefined,
    schemaNote: 'none (free-text summary returned in `result`)',
    userPrompt: [
      'Summarize the following email thread.',
      '',
      'Thread subject: v2 API spec + staging outage before Friday demo',
      '',
      '--- Message 1 ---',
      'From: petr@client.example',
      '',
      'Can you send the v2 API spec before the Friday 10:00 demo? Staging is also down which is blocking us.',
      '',
      '--- Message 2 ---',
      'From: jan@me.example',
      '',
      "I'll send the API spec by Thursday EOD. Can you get me the updated staging credentials so I can verify?",
    ].join('\n'),
  },
};

async function sha256OfFile(filePath) {
  const content = await readFile(filePath, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

/** Build the same argv the real runner builds (kept in lockstep with build-args.ts). */
function buildArgs(job) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    job.modelAlias,
    '--permission-mode',
    'dontAsk',
    '--system-prompt-file',
    path.join(promptsDir, job.promptFile),
  ];
  if (job.jsonSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(job.jsonSchema));
  }
  args.push('--allowedTools', 'Read');
  return args;
}

/** Hard cap so a stalled `claude` call can't hang fixture regeneration forever. */
const CLAUDE_TIMEOUT_MS = 120_000;

/** Spawn `claude` (live) and resolve the raw stdout JSON envelope object. */
function runClaude(job) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', buildArgs(job), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`)));
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => {
      settle(() => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (err) {
          reject(new Error(`claude exited ${code}, unparseable stdout: ${err.message}\n${stderr}`));
        }
      });
    });
    child.stdin.write(job.userPrompt);
    child.stdin.end();
  });
}

function renderFixture(job, envelope, promptHash) {
  const date = new Date().toISOString().slice(0, 10);
  return `// GENERATED — do not hand-edit; run \`npm run refresh-fixtures\`
//
// Recorded \`claude --output-format json\` envelope for a ${job.label} job (PLAN.md §4.8).
//
//   task:        ${job.promptFile.replace('.md', '')}
//   model alias: ${job.modelAlias}
//   schema:      ${job.schemaNote}
//   prompt hash: sha256:${promptHash} (${job.promptFile})
//   captured:    ${date}
import type { ClaudeJsonEnvelope } from '../../types';

export const ${job.constName}: ClaudeJsonEnvelope = ${JSON.stringify(envelope, null, 2)};
`;
}

async function refreshOne(name) {
  const job = JOBS[name];
  if (job === undefined) {
    throw new Error(`unknown fixture "${name}"; known: ${Object.keys(JOBS).join(', ')}`);
  }
  console.log(`refresh-fixtures: capturing ${name} (live ${job.modelAlias})…`);
  const promptHash = await sha256OfFile(path.join(promptsDir, job.promptFile));
  const envelope = await runClaude(job);
  const out = renderFixture(job, envelope, promptHash);
  const target = path.join(fixturesDir, job.file);
  await writeFile(target, out, 'utf8');
  console.log(`refresh-fixtures: wrote ${path.relative(repoRoot, target)}`);
}

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length > 0 ? requested : Object.keys(JOBS);
  for (const name of names) {
    await refreshOne(name);
  }
  console.log('refresh-fixtures: done.');
}

main().catch((err) => {
  console.error(`refresh-fixtures failed: ${err.message}`);
  process.exit(1);
});
