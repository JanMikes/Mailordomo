/**
 * Local setup/config contracts (PLAN.md §7 Phase 8, decision D33) — the shapes the setup wizard
 * frontend and the backend wizard API share. These describe MACHINE-LOCAL app config (projects →
 * mailboxes → repos) plus the wizard request/response DTOs and the provider presets.
 *
 * GOLDEN RULE #4 — SECRETS NEVER LIVE IN A STORED OR RETURNED SHAPE.
 *   - Every STORED shape (ProjectConfig, MailboxConfig, MailordomoConfig, RepoPointer,
 *     LocalRepoConfig) and every RESPONSE shape (MailboxConfigResponse, CredentialPresence,
 *     RepoConfigResponse, …) is a `z.strictObject` with NO password/token/secret field. A password
 *     therefore cannot round-trip back out of the config file or any API response.
 *   - The ONLY place a secret appears is as an INBOUND request field — `AddMailboxRequest.imapPassword`
 *     / `.smtpPassword`, `UpdateMailboxRequest.*Password`, and `StoreCredentialRequest.secret`. The
 *     backend immediately routes these to the `CredentialStore` (Keychain / `{mailbox}.env`) and NEVER
 *     persists them in the config JSON, echoes them in a response, or logs them.
 *
 * PRIVACY (Golden rule #3 / D13): a repo's machine-local clone PATH lives ONLY in `LocalRepoConfig`
 * (`local_path`), never in the shared `RepoPointer` identity (name + git_url). Only identity is ever
 * shareable with the metadata service.
 */
import { z } from 'zod';
import { LocalRepoConfigSchema, RepoPointerSchema } from './entities';
import { EmailAddressSchema, IdSchema } from './primitives';

/* -------------------------------------------------------------------------- */
/* Credential kinds (the keys into the CredentialStore — NEVER the values)     */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of secret the backend's `CredentialStore` holds, keyed by `(account, kind)`. The SECRET
 * VALUES are never part of any schema here — only this closed vocabulary of which slot a secret
 * occupies.
 */
export const CREDENTIAL_KINDS = ['imap', 'smtp', 'metadata-token', 'repo-pat'] as const;
export const CredentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/* -------------------------------------------------------------------------- */
/* Non-secret structured config (lives in $MAILORDOMO_CONFIG_DIR/config.json)  */
/* -------------------------------------------------------------------------- */

/**
 * One transport endpoint (IMAP or SMTP) — host/port/TLS + login user. NON-SECRET by construction:
 * there is deliberately NO `password` field (the password lives in the CredentialStore, keyed by the
 * mailbox id). `secure` is implicit-TLS (993/465); `secure:false` on a submission port (587) means
 * STARTTLS — same convention as imapflow/nodemailer.
 */
export const MailboxEndpointSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
});
export type MailboxEndpoint = z.infer<typeof MailboxEndpointSchema>;

/** A project (employer/workspace) as machine-local config — id + display name only. */
export const ProjectConfigSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * A configured mailbox — its IMAP + SMTP endpoints (NON-secret). The password is NOT here: it is in
 * the CredentialStore under `(id, 'imap')` / `(id, 'smtp')`. Strict, so a smuggled `password`/`pass`
 * key fails `parse()` before it could ever reach the config file.
 */
export const MailboxConfigSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  address: EmailAddressSchema,
  imap: MailboxEndpointSchema,
  smtp: MailboxEndpointSchema,
});
export type MailboxConfig = z.infer<typeof MailboxConfigSchema>;

/**
 * The whole `config.json`: projects → mailboxes → repos. `repoPointers` holds the SHAREABLE repo
 * IDENTITY (name + git_url, the future metadata-service payload); `repos` holds the MACHINE-LOCAL
 * {@link LocalRepoConfigSchema} (clone path + pull policy) that must never reach the server. NO
 * secret of any kind lives in this object.
 */
export const MailordomoConfigSchema = z.strictObject({
  projects: z.array(ProjectConfigSchema),
  mailboxes: z.array(MailboxConfigSchema),
  repoPointers: z.array(RepoPointerSchema),
  repos: z.array(LocalRepoConfigSchema),
});
export type MailordomoConfig = z.infer<typeof MailordomoConfigSchema>;

/** The empty config a fresh install starts from (also the fallback on a missing/corrupt file). */
export const DEFAULT_MAILORDOMO_CONFIG: MailordomoConfig = {
  projects: [],
  mailboxes: [],
  repoPointers: [],
  repos: [],
};

/* -------------------------------------------------------------------------- */
/* Provider presets (pure data — host/port/security + guidance)                */
/* -------------------------------------------------------------------------- */

export const PROVIDER_IDS = ['icloud', 'gmail', 'custom'] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** A preset endpoint — host/port/TLS only (no user/password; the user fills those in). */
export const ProviderEndpointPresetSchema = z.strictObject({
  host: z.string(),
  port: z.number().int().positive(),
  secure: z.boolean(),
});
export type ProviderEndpointPreset = z.infer<typeof ProviderEndpointPresetSchema>;

/** A provider preset: prefilled IMAP/SMTP endpoints + a short human guidance string. */
export const ProviderPresetSchema = z.strictObject({
  id: ProviderIdSchema,
  label: z.string().min(1),
  imap: ProviderEndpointPresetSchema,
  smtp: ProviderEndpointPresetSchema,
  guidance: z.string(),
});
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

/**
 * The shipped provider presets (PROJECT.md §10). iCloud + Gmail both REQUIRE an app-specific
 * password; Gmail OAuth2 is deferred. Hosts/ports are load-bearing — the wizard prefills them and the
 * test author asserts them.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'icloud',
    label: 'iCloud (me.com / icloud.com)',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, // 587 = STARTTLS
    guidance:
      'iCloud requires an app-specific password. Create one at appleid.apple.com → Sign-In and ' +
      'Security → App-Specific Passwords, then paste it as the IMAP and SMTP password.',
  },
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, // 465 = implicit TLS
    guidance:
      'Gmail needs an app password (enable 2-Step Verification, then myaccount.google.com → ' +
      'Security → App passwords). OAuth2 is deferred for v1 — use an app password for now.',
  },
  {
    id: 'custom',
    label: 'Custom / other provider',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    guidance:
      "Enter your provider's IMAP and SMTP host, port, and TLS mode. Port 993/465 with TLS on, or " +
      'a submission port (587) with TLS off for STARTTLS.',
  },
];

/* -------------------------------------------------------------------------- */
/* Wizard request DTOs                                                          */
/* -------------------------------------------------------------------------- */

/** Create a project. `id` is optional (provide the metadata project id to pair them; else generated). */
export const AddProjectRequestSchema = z.strictObject({
  id: IdSchema.optional(),
  name: z.string().min(1),
});
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;

/**
 * Add a mailbox. `imap`/`smtp` are the NON-secret endpoints persisted in config. `imapPassword` /
 * `smtpPassword` are the ⚠️ INBOUND-ONLY SECRET FIELDS — the backend routes them straight to the
 * CredentialStore and NEVER persists them in config or echoes them back. They are the ONLY way a
 * password enters the system; the response is credential-PRESENCE booleans only.
 */
export const AddMailboxRequestSchema = z.strictObject({
  id: IdSchema.optional(),
  projectId: IdSchema,
  address: EmailAddressSchema,
  imap: MailboxEndpointSchema,
  smtp: MailboxEndpointSchema,
  imapPassword: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
});
export type AddMailboxRequest = z.infer<typeof AddMailboxRequestSchema>;

/** Patch a mailbox's endpoints and/or its stored passwords (same inbound-only-secret rule). */
export const UpdateMailboxRequestSchema = z.strictObject({
  address: EmailAddressSchema.optional(),
  imap: MailboxEndpointSchema.optional(),
  smtp: MailboxEndpointSchema.optional(),
  imapPassword: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
});
export type UpdateMailboxRequest = z.infer<typeof UpdateMailboxRequestSchema>;

/**
 * Write a single secret to the CredentialStore (the generic write path for metadata-token / repo-pat
 * too). `secret` is ⚠️ INBOUND-ONLY — write-only; the response is a {@link CredentialPresenceSchema}
 * (no value).
 */
export const StoreCredentialRequestSchema = z.strictObject({
  account: z.string().min(1),
  kind: CredentialKindSchema,
  secret: z.string().min(1),
});
export type StoreCredentialRequest = z.infer<typeof StoreCredentialRequestSchema>;

/**
 * Link a repo (PROJECT.md §10, D13). `git_url` is the SHAREABLE identity and is required (even a
 * local clone has an origin). `local_path` present ⇒ local-path mode (validated, read via
 * `--add-dir`); absent ⇒ git-URL mirror mode (a read-only `clone --mirror` under the config dir).
 * `active_pull` enables scheduled `git fetch` for the mirror.
 */
export const LinkRepoRequestSchema = z.strictObject({
  repo_pointer_id: IdSchema.optional(),
  project_id: IdSchema,
  name: z.string().min(1),
  git_url: z.string().min(1),
  local_path: z.string().min(1).optional(),
  active_pull: z.boolean(),
});
export type LinkRepoRequest = z.infer<typeof LinkRepoRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Wizard response DTOs (SECRET-FREE by construction)                          */
/* -------------------------------------------------------------------------- */

/** Whether a credential slot is populated — PRESENCE only, NEVER the value (Golden rule #4). */
export const CredentialPresenceSchema = z.strictObject({
  account: z.string().min(1),
  kind: CredentialKindSchema,
  present: z.boolean(),
});
export type CredentialPresence = z.infer<typeof CredentialPresenceSchema>;

/** Per-mailbox credential presence booleans (no secret). */
export const MailboxCredentialsPresenceSchema = z.strictObject({
  imap: z.boolean(),
  smtp: z.boolean(),
});
export type MailboxCredentialsPresence = z.infer<typeof MailboxCredentialsPresenceSchema>;

/** A mailbox as returned by the wizard: its NON-secret config + which credentials are present. */
export const MailboxConfigResponseSchema = z.strictObject({
  mailbox: MailboxConfigSchema,
  credentials: MailboxCredentialsPresenceSchema,
});
export type MailboxConfigResponse = z.infer<typeof MailboxConfigResponseSchema>;

/** A linked repo as returned: shareable identity + the machine-local clone/pull config. */
export const RepoConfigResponseSchema = z.strictObject({
  pointer: RepoPointerSchema,
  local: LocalRepoConfigSchema,
});
export type RepoConfigResponse = z.infer<typeof RepoConfigResponseSchema>;

/** The read-only `test-connection` result — a boolean + a human reason, NEVER any credential. */
export const TestConnectionResultSchema = z.strictObject({
  ok: z.boolean(),
  reason: z.string(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

export const ProjectListResponseSchema = z.strictObject({
  projects: z.array(ProjectConfigSchema),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

export const MailboxListResponseSchema = z.strictObject({
  mailboxes: z.array(MailboxConfigResponseSchema),
});
export type MailboxListResponse = z.infer<typeof MailboxListResponseSchema>;

export const RepoListResponseSchema = z.strictObject({
  repos: z.array(RepoConfigResponseSchema),
});
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;

export const ProviderPresetListResponseSchema = z.strictObject({
  presets: z.array(ProviderPresetSchema),
});
export type ProviderPresetListResponse = z.infer<typeof ProviderPresetListResponseSchema>;
