/**
 * The setup-wizard API routes (PLAN.md §7 Phase 8, decision D33). Registered ADDITIVELY onto the main
 * backend Hono app by `createBackendApi` when the config + credential stores are wired. Every route
 * lives under `/api/wizard/*`.
 *
 * GOLDEN RULE #4 — THE GOVERNING CONSTRAINT HERE:
 *   - Secrets enter ONLY as inbound request fields (`AddMailboxRequest.imapPassword`/`.smtpPassword`,
 *     `UpdateMailboxRequest.*Password`, `StoreCredentialRequest.secret`). The handler routes them
 *     STRAIGHT to the {@link CredentialStore} and writes the NON-secret config via {@link ConfigStore}.
 *   - NO response ever echoes a secret. Credential reads return PRESENCE booleans only.
 *   - NO request body is logged. Validation failures return field PATHS (names), never values.
 * GOLDEN RULE #1/#3: `test-connection` is a read-only IMAP login (no send, no body); nothing here
 * starts a daemon/sync loop. GOLDEN RULE #3 (server boundary): only repo IDENTITY (name+git_url) is
 * ever shareable; the machine-local `local_path` stays in `LocalRepoConfig`, never sent anywhere.
 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Hono } from 'hono';
import type { z } from 'zod';
import type {
  CredentialPresence,
  LocalRepoConfig,
  MailboxConfig,
  MailboxConfigResponse,
  ProjectConfig,
  RepoConfigResponse,
  RepoPointer,
} from '@mailordomo/shared';
import {
  AddMailboxRequestSchema,
  AddProjectRequestSchema,
  CredentialKindSchema,
  LinkRepoRequestSchema,
  PROVIDER_PRESETS,
  StoreCredentialRequestSchema,
  UpdateMailboxRequestSchema,
} from '@mailordomo/shared';
import type { ConfigStore } from '../config';
import {
  addMailbox,
  addProject,
  ConfigError,
  linkRepo,
  removeMailbox,
  updateMailbox,
} from '../config';
import type { CredentialStore } from '../credentials';
import { isSafeAccount } from '../credentials';
import type { GitRunner } from '../repos';
import { mirrorClone, mirrorFetch, resolveRepoMirrorDir, validateLocalRepoPath } from '../repos';
import type { ImapConnectionTester } from './test-connection';
import type { WiringStatus } from './wiring';
import { checkClaudeVersion } from './wiring';

/** Dependencies the wizard routes need. `configStore` + `credentialStore` are required; the rest opt. */
export interface WizardDeps {
  readonly configStore: ConfigStore;
  readonly credentialStore: CredentialStore;
  /** Read-only IMAP login seam for `test-connection` (default real impl wired by `server.ts`). */
  readonly imapTester?: ImapConnectionTester;
  /** Git seam for repo-mirror operations (default real impl wired by `server.ts`). */
  readonly gitRunner?: GitRunner;
  /** Override the Claude health probe (default `checkClaudeVersion`). */
  readonly checkClaudeVersion?: () => Promise<WiringStatus>;
  /** Environment for path resolution (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/** Map a ConfigError code to an HTTP status. */
function statusFor(err: ConfigError): 404 | 409 {
  return err.code === 'not_found' ? 404 : 409;
}

/** Field PATHS (names only — never values) from a failed parse, for a safe 400 body. */
function fieldPaths(error: z.ZodError): string[] {
  return error.issues.map((i) => i.path.join('.')).filter((p) => p !== '');
}

/**
 * Register the wizard routes on `app`. Idempotent per app instance (call once). Secrets never touch
 * the config store or any response by construction (see file header).
 */
export function registerWizardRoutes(app: Hono, deps: WizardDeps): void {
  const { configStore, credentialStore } = deps;
  const env = deps.env ?? process.env;
  const claudeHealth = deps.checkClaudeVersion ?? (() => checkClaudeVersion(4000, env));

  /** Resolve a mailbox's credential-presence booleans (no secret values cross). */
  async function mailboxCredentials(
    mailboxId: string,
  ): Promise<MailboxConfigResponse['credentials']> {
    const [imap, smtp] = await Promise.all([
      credentialStore.get(mailboxId, 'imap'),
      credentialStore.get(mailboxId, 'smtp'),
    ]);
    return { imap: imap !== undefined, smtp: smtp !== undefined };
  }

  async function mailboxResponse(mailbox: MailboxConfig): Promise<MailboxConfigResponse> {
    return { mailbox, credentials: await mailboxCredentials(mailbox.id) };
  }

  /* ------------------------------ presets + health ------------------------------ */

  /** Provider presets (pure data) for the wizard's mailbox step. */
  app.get('/api/wizard/presets', (c) => c.json({ presets: PROVIDER_PRESETS }, 200));

  /** Claude binary health (resolve + `--version`) for the wizard's health step. */
  app.get('/api/wizard/health', async (c) => c.json(await claudeHealth(), 200));

  /** The whole NON-secret config (for the raw-config editing view; no secrets present by construction). */
  app.get('/api/wizard/config', (c) => c.json(configStore.read(), 200));

  /* --------------------------------- projects ---------------------------------- */

  app.get('/api/wizard/projects', (c) => c.json({ projects: configStore.read().projects }, 200));

  app.post('/api/wizard/projects', async (c) => {
    const parsed = AddProjectRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid project', code: 'invalid', fields: fieldPaths(parsed.error) },
        400,
      );
    }
    const project: ProjectConfig = { id: parsed.data.id ?? randomUUID(), name: parsed.data.name };
    try {
      configStore.update((cfg) => addProject(cfg, project));
    } catch (err) {
      if (err instanceof ConfigError)
        return c.json({ error: err.message, code: err.code }, statusFor(err));
      throw err;
    }
    return c.json(project, 201);
  });

  /* --------------------------------- mailboxes --------------------------------- */

  app.get('/api/wizard/mailboxes', async (c) => {
    const mailboxes = await Promise.all(configStore.read().mailboxes.map(mailboxResponse));
    return c.json({ mailboxes }, 200);
  });

  app.post('/api/wizard/mailboxes', async (c) => {
    const parsed = AddMailboxRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid mailbox', code: 'invalid', fields: fieldPaths(parsed.error) },
        400,
      );
    }
    const { imapPassword, smtpPassword, ...rest } = parsed.data;
    // The NON-secret mailbox config — passwords are deliberately NOT spread in.
    const mailbox: MailboxConfig = {
      id: rest.id ?? randomUUID(),
      projectId: rest.projectId,
      address: rest.address,
      imap: rest.imap,
      smtp: rest.smtp,
    };
    // Persist config FIRST so a conflict (dup id/address) aborts before any secret is written.
    try {
      configStore.update((cfg) => addMailbox(cfg, mailbox));
    } catch (err) {
      if (err instanceof ConfigError)
        return c.json({ error: err.message, code: err.code }, statusFor(err));
      throw err;
    }
    // Route the inbound secrets straight to the CredentialStore (never persisted in config / echoed).
    if (imapPassword !== undefined) await credentialStore.set(mailbox.id, 'imap', imapPassword);
    if (smtpPassword !== undefined) await credentialStore.set(mailbox.id, 'smtp', smtpPassword);
    return c.json(await mailboxResponse(mailbox), 201);
  });

  app.patch('/api/wizard/mailboxes/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = UpdateMailboxRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid mailbox patch', code: 'invalid', fields: fieldPaths(parsed.error) },
        400,
      );
    }
    const { imapPassword, smtpPassword, ...endpoints } = parsed.data;
    // Apply only the NON-secret endpoint fields to config.
    const patch: Partial<Omit<MailboxConfig, 'id' | 'projectId'>> = {};
    if (endpoints.address !== undefined) patch.address = endpoints.address;
    if (endpoints.imap !== undefined) patch.imap = endpoints.imap;
    if (endpoints.smtp !== undefined) patch.smtp = endpoints.smtp;
    let stored: MailboxConfig;
    try {
      const next = configStore.update((cfg) => updateMailbox(cfg, id, patch));
      stored = next.mailboxes.find((m) => m.id === id) as MailboxConfig;
    } catch (err) {
      if (err instanceof ConfigError)
        return c.json({ error: err.message, code: err.code }, statusFor(err));
      throw err;
    }
    if (imapPassword !== undefined) await credentialStore.set(id, 'imap', imapPassword);
    if (smtpPassword !== undefined) await credentialStore.set(id, 'smtp', smtpPassword);
    return c.json(await mailboxResponse(stored), 200);
  });

  /**
   * Remove a mailbox: drop the NON-secret config entry AND both credential slots (imap + smtp) from the
   * CredentialStore. Credential deletion is best-effort/idempotent (a no-op when a slot is absent). No
   * secret is read or echoed (Golden rule #4). NOTE: the running daemon binds its watched mailbox at
   * startup (single-mailbox v1, D32) — removing it fully takes effect on the next backend restart.
   */
  app.delete('/api/wizard/mailboxes/:id', async (c) => {
    const id = c.req.param('id');
    try {
      configStore.update((cfg) => removeMailbox(cfg, id));
    } catch (err) {
      if (err instanceof ConfigError)
        return c.json({ error: err.message, code: err.code }, statusFor(err));
      throw err;
    }
    // Best-effort: the config row is already gone, so never let a Keychain hiccup (the `security` CLI
    // can throw on a real error) turn a successful removal into a 500. Log + continue; a missed slot is
    // orphaned but unreferenced (and overwritten if the same id is ever re-added).
    await Promise.all(
      (['imap', 'smtp'] as const).map((kind) =>
        credentialStore.delete(id, kind).catch((cause: unknown) => {
          console.error(`[wizard] failed to delete ${kind} credential for mailbox ${id}`, cause);
        }),
      ),
    );
    return c.json({ id, removed: true }, 200);
  });

  /**
   * Read-only connection test (golden rules #1/#3/#4): look up the mailbox + its stored IMAP password,
   * attempt a read-only login via the seam, return `{ ok, reason }`. NO credential in the response.
   */
  app.post('/api/wizard/mailboxes/:id/test-connection', async (c) => {
    if (deps.imapTester === undefined) {
      return c.json({ error: 'test-connection not configured', code: 'unavailable' }, 503);
    }
    const id = c.req.param('id');
    const mailbox = configStore.read().mailboxes.find((m) => m.id === id);
    if (mailbox === undefined) return c.json({ error: 'unknown mailbox', code: 'not_found' }, 404);
    const pass = await credentialStore.get(id, 'imap');
    if (pass === undefined) {
      return c.json({ ok: false, reason: 'no IMAP password stored for this mailbox' }, 200);
    }
    const result = await deps.imapTester.test({
      host: mailbox.imap.host,
      port: mailbox.imap.port,
      secure: mailbox.imap.secure,
      user: mailbox.imap.user,
      pass,
    });
    return c.json(result, 200);
  });

  /* ----------------------------------- repos ----------------------------------- */

  app.get('/api/wizard/repos', (c) => {
    const cfg = configStore.read();
    const repos: RepoConfigResponse[] = cfg.repos.flatMap((local) => {
      const pointer = cfg.repoPointers.find((p) => p.id === local.repo_pointer_id);
      return pointer ? [{ pointer, local }] : [];
    });
    return c.json({ repos }, 200);
  });

  app.post('/api/wizard/repos', async (c) => {
    const parsed = LinkRepoRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid repo', code: 'invalid', fields: fieldPaths(parsed.error) },
        400,
      );
    }
    const req = parsed.data;
    const cfg = configStore.read();
    if (!cfg.projects.some((p) => p.id === req.project_id)) {
      return c.json({ error: `unknown project "${req.project_id}"`, code: 'not_found' }, 404);
    }
    const id = req.repo_pointer_id ?? randomUUID();
    // Identity is shareable (name + git_url); the local path is machine-local (D13).
    const pointer: RepoPointer = {
      id,
      project_id: req.project_id,
      name: req.name,
      git_url: req.git_url,
    };
    // Local-path mode validates the live clone; git-URL mode uses a read-only mirror dir as the path.
    let local: LocalRepoConfig;
    if (req.local_path !== undefined) {
      const check = validateLocalRepoPath(req.local_path);
      if (!check.ok) {
        return c.json({ error: `invalid local_path: ${check.reason}`, code: 'invalid' }, 400);
      }
      local = { repo_pointer_id: id, local_path: req.local_path, active_pull: req.active_pull };
    } else {
      local = {
        repo_pointer_id: id,
        local_path: resolveRepoMirrorDir(id, env),
        active_pull: req.active_pull,
      };
    }
    configStore.update((current) => linkRepo(current, pointer, local));
    const body: RepoConfigResponse = { pointer, local };
    return c.json(body, 201);
  });

  /**
   * Manually refresh a git-URL repo's read-only mirror (an explicit user action — no background loop).
   * Clones `--mirror` if the mirror is absent, else `fetch --prune`. Local-path repos have no mirror.
   */
  app.post('/api/wizard/repos/:id/pull', async (c) => {
    if (deps.gitRunner === undefined) {
      return c.json({ error: 'git not configured', code: 'unavailable' }, 503);
    }
    const id = c.req.param('id');
    const cfg = configStore.read();
    const pointer = cfg.repoPointers.find((p) => p.id === id);
    const local = cfg.repos.find((r) => r.repo_pointer_id === id);
    if (pointer === undefined || local === undefined) {
      return c.json({ error: 'unknown repo', code: 'not_found' }, 404);
    }
    const mirrorDir = resolveRepoMirrorDir(id, env);
    if (local.local_path !== mirrorDir) {
      return c.json({ ok: false, reason: 'repo is in local-path mode (no mirror to pull)' }, 200);
    }
    const exists = ((): boolean => {
      try {
        return statSync(mirrorDir).isDirectory();
      } catch {
        return false;
      }
    })();
    const result = exists
      ? await mirrorFetch(deps.gitRunner, mirrorDir)
      : await mirrorClone(deps.gitRunner, pointer.git_url, mirrorDir);
    return c.json(
      {
        ok: result.code === 0,
        reason: result.code === 0 ? (exists ? 'fetched' : 'cloned') : result.stderr.trim(),
      },
      200,
    );
  });

  /* -------------------------------- credentials -------------------------------- */

  /** Write a secret (WRITE-ONLY — the response is presence, never the value). */
  app.put('/api/wizard/credentials', async (c) => {
    const parsed = StoreCredentialRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json(
        { error: 'invalid credential', code: 'invalid', fields: fieldPaths(parsed.error) },
        400,
      );
    }
    const { account, kind, secret } = parsed.data;
    await credentialStore.set(account, kind, secret);
    const body: CredentialPresence = { account, kind, present: true };
    return c.json(body, 200);
  });

  /** Whether a credential is present (boolean) — NEVER the value. */
  app.get('/api/wizard/credentials/:account/:kind', async (c) => {
    const account = c.req.param('account');
    if (!isSafeAccount(account))
      return c.json({ error: 'invalid credential account', code: 'invalid' }, 400);
    const kindParsed = CredentialKindSchema.safeParse(c.req.param('kind'));
    if (!kindParsed.success)
      return c.json({ error: 'invalid credential kind', code: 'invalid' }, 400);
    const value = await credentialStore.get(account, kindParsed.data);
    const body: CredentialPresence = {
      account,
      kind: kindParsed.data,
      present: value !== undefined,
    };
    return c.json(body, 200);
  });

  app.delete('/api/wizard/credentials/:account/:kind', async (c) => {
    const account = c.req.param('account');
    if (!isSafeAccount(account))
      return c.json({ error: 'invalid credential account', code: 'invalid' }, 400);
    const kindParsed = CredentialKindSchema.safeParse(c.req.param('kind'));
    if (!kindParsed.success)
      return c.json({ error: 'invalid credential kind', code: 'invalid' }, 400);
    await credentialStore.delete(account, kindParsed.data);
    const body: CredentialPresence = { account, kind: kindParsed.data, present: false };
    return c.json(body, 200);
  });
}
