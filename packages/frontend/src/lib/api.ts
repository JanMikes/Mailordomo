/**
 * The typed REST client for the localhost backend (PLAN.md §7 Phase 7a / D29). Components NEVER call
 * `fetch` directly — they go through these functions (or the `today-hooks` wrappers), so request
 * shapes, the `/api` prefix, and response validation live in exactly one place.
 *
 * Responses are validated against the `@mailordomo/shared` zod schemas: the Today/Settings models are
 * strict + body-free by construction, so a parse here is both a type guarantee AND a privacy/contract
 * check — drift or a smuggled field surfaces as a loud error instead of silently rendering.
 *
 * GOLDEN RULE #1: there is deliberately no send/draft call here. The only task mutations are the
 * metadata writes the 7a backend exposes — `markDone` (a state transition) and `snooze` (a
 * `follow_up_at` edit). Drafting/sending arrives in 7b behind an explicit user action.
 */
import type {
  AcquireLockResponse,
  AddMailboxRequest,
  AddProjectRequest,
  AppSettings,
  CredentialKind,
  CredentialPresence,
  DigestMetadata,
  LearningEntry,
  LinkRepoRequest,
  Lock,
  MailboxConfigResponse,
  MailordomoConfig,
  ProjectConfig,
  ProjectResponse,
  ProjectsBoard,
  ProviderPreset,
  ReleaseLockResponse,
  RepoConfigResponse,
  StoreCredentialRequest,
  Task,
  TestConnectionResult,
  ThreadDetail,
  TodayReadModel,
  UpdateMailboxRequest,
  UpdateSettingsRequest,
} from '@mailordomo/shared';
import {
  AcquireLockResponseSchema,
  AppSettingsSchema,
  CredentialPresenceSchema,
  DigestMetadataSchema,
  LearningEntryListResponseSchema,
  LearningEntrySchema,
  LockSchema,
  MailboxConfigResponseSchema,
  MailboxListResponseSchema,
  MailordomoConfigSchema,
  ProjectConfigSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  ProjectsBoardResponseSchema,
  ProviderPresetListResponseSchema,
  ReleaseLockResponseSchema,
  RepoConfigResponseSchema,
  RepoListResponseSchema,
  TaskSchema,
  TestConnectionResultSchema,
  ThreadDetailSchema,
  TodayReadModelSchema,
} from '@mailordomo/shared';

/** Stable React Query keys (centralized so invalidation can never typo a key). */
export const queryKeys = {
  today: ['today'] as const,
  digest: ['digest'] as const,
  settings: ['settings'] as const,
  learning: ['learning'] as const,
  projectsBoard: ['projects-board'] as const,
  project: ['project'] as const,
  threadDetail: (threadId: string) => ['thread', threadId, 'detail'] as const,
  messageBody: (threadId: string, messageId: string) =>
    ['thread', threadId, 'body', messageId] as const,
  draft: (threadId: string) => ['thread', threadId, 'draft'] as const,
  /**
   * Setup-wizard query keys (Phase 8 / D33). GOLDEN RULE #4: a key NEVER contains a secret — the
   * credential key carries only the `(account, kind)` SLOT identity, never the password/token value.
   */
  wizard: {
    presets: ['wizard', 'presets'] as const,
    health: ['wizard', 'health'] as const,
    config: ['wizard', 'config'] as const,
    projects: ['wizard', 'projects'] as const,
    mailboxes: ['wizard', 'mailboxes'] as const,
    repos: ['wizard', 'repos'] as const,
    credential: (account: string, kind: CredentialKind) =>
      ['wizard', 'credential', account, kind] as const,
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/**
 * A failed `/api` request. Carries the HTTP `status` and the backend's `code` (e.g. `not_found`,
 * `unavailable`, `conflict`) so callers can branch on them — a 404 draft means "none yet", a 409
 * refresh means "lost the lock", a 503 means "feature unconfigured" — instead of string-matching.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fetch `/api{path}`, throwing an {@link ApiError} (preferring the backend's `{error}`/`{code}`). */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object') {
        if ('error' in body) detail = String((body as { error: unknown }).error);
        if ('code' in body) code = String((body as { code: unknown }).code);
      }
    } catch {
      // non-JSON error body — keep the status-code detail
    }
    throw new ApiError(`${path} — ${detail}`, res.status, code);
  }
  return res.json();
}

/** GET the assembled Today read model (metrics + counts + ranked do-next cards). */
export async function fetchToday(): Promise<TodayReadModel> {
  return TodayReadModelSchema.parse(await request('/today'));
}

/**
 * The morning-digest view model (PROJECT.md §9 / D34): the body-free {@link DigestMetadata} plus the
 * LOCALLY-synthesized narrative `prose`. The server only ever supplies the metadata; the prose is
 * synthesized on this machine (Golden rule #3), so it is local free text, not a server contract.
 */
export interface DigestView {
  readonly metadata: DigestMetadata;
  readonly prose: string;
}

/**
 * GET the morning digest (`{ metadata, prose }`). The METADATA is zod-parsed against the shared
 * `DigestMetadataSchema` — the same strict, body-free guarantee the rest of this client relies on, so
 * a smuggled body field surfaces as a loud error. `prose` is local-only synthesized narrative (empty
 * when the backend declined synthesis under backpressure / without a runner), kept as a plain string.
 */
export async function fetchDigest(): Promise<DigestView> {
  const raw = (await request('/digest')) as { metadata: unknown; prose?: unknown };
  return {
    metadata: DigestMetadataSchema.parse(raw.metadata),
    prose: typeof raw.prose === 'string' ? raw.prose : '',
  };
}

/**
 * GET the assembled projects board — every project's threads grouped by task state (D32). A body-free
 * LOCAL read model (subject/snippet/sender + state metadata only); the parse enforces that.
 */
export async function fetchProjectsBoard(): Promise<ProjectsBoard> {
  return ProjectsBoardResponseSchema.parse(await request('/projects-board'));
}

/** GET the configured project's identity (`{ id, name }`); `name` is null when unresolved (D32). */
export async function fetchProject(): Promise<ProjectResponse> {
  return ProjectResponseSchema.parse(await request('/project'));
}

/** GET the local app settings (stale thresholds, lock timeout, color scheme, default view). */
export async function fetchSettings(): Promise<AppSettings> {
  return AppSettingsSchema.parse(await request('/settings'));
}

/** PUT a partial settings patch; returns the full updated settings. */
export async function updateSettings(patch: UpdateSettingsRequest): Promise<AppSettings> {
  return AppSettingsSchema.parse(
    await request('/settings', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),
  );
}

/** The shape of `POST /api/tasks/:id/done` (a backend-local response, not a shared DTO). */
export interface MarkDoneResult {
  readonly threadId: string;
  readonly state: 'done';
  readonly changed: boolean;
}

/** Mark a thread's task done — a metadata state transition (NOT a send). */
export async function markDone(threadId: string): Promise<MarkDoneResult> {
  const body = await request(`/tasks/${encodeURIComponent(threadId)}/done`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  });
  return body as MarkDoneResult;
}

/** Snooze a thread's task — set its `follow_up_at` (defaults to 24h out server-side when omitted). */
export async function snooze(threadId: string, followUpAt?: string): Promise<Task> {
  const body = followUpAt === undefined ? '{}' : JSON.stringify({ follow_up_at: followUpAt });
  return TaskSchema.parse(
    await request(`/tasks/${encodeURIComponent(threadId)}/snooze`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    }),
  );
}

/* ============================ Phase 7b — work surface ============================ */
/*
 * GOLDEN RULE #3: every call below is to the LOCAL 127.0.0.1 backend (the `/api` proxy). Draft
 * bodies, refine transcripts, and rendered message bodies are LOCAL-only hops — this client never
 * posts a body to anything else, and nothing here is persisted in localStorage.
 */

/** One turn in the refine chat (a backend-local shape, not a server DTO). */
export interface RefineTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** The LOCAL draft payload (body + transcript live only on this machine — golden rule #3). */
export interface DraftResponse {
  readonly body: string;
  readonly model: string;
  readonly version: number;
  readonly transcript: RefineTurn[];
}

/** The result of a manual send (golden rule #1 — only ever fired by an explicit user click). */
export interface SendResult {
  readonly messageId: string;
  readonly filedTo: string | null;
  readonly state: 'waiting';
}

/** GET the body-free thread detail for the left pane (validated against the strict shared schema). */
export async function fetchThreadDetail(threadId: string): Promise<ThreadDetail> {
  return ThreadDetailSchema.parse(await request(`/threads/${encodeURIComponent(threadId)}`));
}

/** GET one message's rendered body — a LOCAL-only hop (parsed from the on-disk `.eml`). */
export async function fetchMessageBody(threadId: string, messageId: string): Promise<string> {
  const body = (await request(
    `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/body`,
  )) as { body: string };
  return body.body;
}

/** GET the current local draft; `null` when none exists yet (404 is an expected, non-error state). */
export async function fetchDraft(threadId: string): Promise<DraftResponse | null> {
  try {
    return (await request(`/threads/${encodeURIComponent(threadId)}/draft`)) as DraftResponse;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** POST to generate the FIRST draft (optional instruction text folded into the Opus prompt). */
export async function generateDraft(
  threadId: string,
  instruction?: string,
): Promise<DraftResponse> {
  const body = instruction ? JSON.stringify({ instruction }) : '{}';
  return (await request(`/threads/${encodeURIComponent(threadId)}/draft`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body,
  })) as DraftResponse;
}

/** POST a refine instruction — the backend replays the transcript into a fresh Opus call (rule #5). */
export async function refineDraft(threadId: string, instruction: string): Promise<DraftResponse> {
  return (await request(`/threads/${encodeURIComponent(threadId)}/draft/refine`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ instruction }),
  })) as DraftResponse;
}

/** The MANUAL send (golden rule #1). `body` is the (possibly user-edited) draft text being sent. */
export async function sendDraft(threadId: string, body: string): Promise<SendResult> {
  return (await request(`/threads/${encodeURIComponent(threadId)}/send`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ body }),
  })) as SendResult;
}

/** Acquire the thread lock on open (no ttl — the backend derives it from `lockTimeoutMinutes`). */
export async function acquireLock(threadId: string): Promise<AcquireLockResponse> {
  return AcquireLockResponseSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/acquire`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** Heartbeat-refresh the held lock; throws an {@link ApiError} 409 if it was lost to another holder. */
export async function refreshLock(threadId: string): Promise<Lock> {
  return LockSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/refresh`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** Release the thread lock on close/unmount. */
export async function releaseLock(threadId: string): Promise<ReleaseLockResponse> {
  return ReleaseLockResponseSchema.parse(
    await request(`/threads/${encodeURIComponent(threadId)}/lock/release`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** GET the learning changelog (always a 200 list; the backend degrades to `[]` on a down call). */
export async function fetchLearning(): Promise<LearningEntry[]> {
  return LearningEntryListResponseSchema.parse(await request('/learning'));
}

/**
 * Revert one learning entry. Throws an {@link ApiError} 409 when the LIFO guard refuses (the target
 * is not the last un-reverted entry for its tone-file, or is already reverted) — surfaced as a calm
 * "revert the most recent change first" message, NOT an alarming failure.
 */
export async function revertLearning(id: string): Promise<LearningEntry> {
  return LearningEntrySchema.parse(
    await request(`/learning/${encodeURIComponent(id)}/revert`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/* ========================= Phase 8 — setup wizard (D33) ==========================
 *
 * GOLDEN RULE #4 governs this whole section:
 *   - A secret enters ONLY as an inbound request BODY field — `addMailbox`'s `imapPassword`/
 *     `smtpPassword`, `updateMailbox`'s `*Password`, and `storeCredential`'s `secret`. It is POSTed to
 *     the LOCAL backend and never returned, never logged (the `request` helper logs nothing), and
 *     never placed in a URL or query key.
 *   - Every RESPONSE is parsed against a SECRET-FREE shared schema (`MailboxConfigResponse` carries
 *     credential PRESENCE booleans only; `CredentialPresence` is a boolean; `test-connection` returns
 *     `{ ok, reason }` with no credential). A smuggled secret field would fail `parse()` loudly.
 */

/** Claude binary health (`GET /api/wizard/health`) — a backend-local `{ ok, detail }` shape. */
export interface WizardHealth {
  readonly ok: boolean;
  readonly detail: string;
}

/** The result of a manual repo mirror refresh (`POST …/repos/:id/pull`) — a backend-local shape. */
export interface RepoPullResult {
  readonly ok: boolean;
  readonly reason: string;
}

/** GET the provider presets (host/port/secure + guidance) for the mailbox step. */
export async function fetchPresets(): Promise<ProviderPreset[]> {
  return ProviderPresetListResponseSchema.parse(await request('/wizard/presets')).presets;
}

/** GET the Claude binary health (resolve + `--version`); never throws on a red layer — it reports it. */
export async function fetchWizardHealth(): Promise<WizardHealth> {
  return (await request('/wizard/health')) as WizardHealth;
}

/** GET the whole NON-secret config (projects → mailboxes → repos) for the advanced/raw view. */
export async function fetchWizardConfig(): Promise<MailordomoConfig> {
  return MailordomoConfigSchema.parse(await request('/wizard/config'));
}

/** GET the configured projects. */
export async function fetchWizardProjects(): Promise<ProjectConfig[]> {
  return ProjectListResponseSchema.parse(await request('/wizard/projects')).projects;
}

/** POST a new project `{ id?, name }`. */
export async function createProject(body: AddProjectRequest): Promise<ProjectConfig> {
  return ProjectConfigSchema.parse(
    await request('/wizard/projects', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

/** GET the configured mailboxes (each with credential-PRESENCE booleans — never the secret). */
export async function fetchMailboxes(): Promise<MailboxConfigResponse[]> {
  return MailboxListResponseSchema.parse(await request('/wizard/mailboxes')).mailboxes;
}

/**
 * POST a new mailbox. `imapPassword`/`smtpPassword` are ⚠️ WRITE-ONLY inbound fields — the backend
 * routes them to the CredentialStore; the response is the secret-free {@link MailboxConfigResponse}.
 */
export async function addMailbox(body: AddMailboxRequest): Promise<MailboxConfigResponse> {
  return MailboxConfigResponseSchema.parse(
    await request('/wizard/mailboxes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

/** PATCH a mailbox's endpoints and/or its stored passwords (same write-only-secret rule). */
export async function updateMailbox(
  id: string,
  body: UpdateMailboxRequest,
): Promise<MailboxConfigResponse> {
  return MailboxConfigResponseSchema.parse(
    await request(`/wizard/mailboxes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

/** POST a read-only IMAP login test for a saved mailbox → `{ ok, reason }` (no credential crosses). */
export async function testConnection(id: string): Promise<TestConnectionResult> {
  return TestConnectionResultSchema.parse(
    await request(`/wizard/mailboxes/${encodeURIComponent(id)}/test-connection`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    }),
  );
}

/** GET the linked repos (shareable identity + machine-local clone/pull config). */
export async function fetchRepos(): Promise<RepoConfigResponse[]> {
  return RepoListResponseSchema.parse(await request('/wizard/repos')).repos;
}

/**
 * POST a repo link. Local-path mode sends `local_path`; git-URL mirror mode omits it. `active_pull`
 * enables the scheduled fetch for a mirror. Only the repo IDENTITY (name + git_url) is shareable.
 */
export async function linkRepo(body: LinkRepoRequest): Promise<RepoConfigResponse> {
  return RepoConfigResponseSchema.parse(
    await request('/wizard/repos', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

/** POST an explicit mirror refresh (clone-if-absent, else fetch) — a user action, no background loop. */
export async function pullRepo(id: string): Promise<RepoPullResult> {
  return (await request(`/wizard/repos/${encodeURIComponent(id)}/pull`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  })) as RepoPullResult;
}

/**
 * PUT a single secret to the CredentialStore. `secret` is ⚠️ WRITE-ONLY — the response is a
 * {@link CredentialPresence} (a boolean), never the value.
 */
export async function storeCredential(body: StoreCredentialRequest): Promise<CredentialPresence> {
  return CredentialPresenceSchema.parse(
    await request('/wizard/credentials', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  );
}

/** GET whether a credential slot is populated — PRESENCE only, never the value. */
export async function fetchCredentialPresence(
  account: string,
  kind: CredentialKind,
): Promise<CredentialPresence> {
  return CredentialPresenceSchema.parse(
    await request(`/wizard/credentials/${encodeURIComponent(account)}/${encodeURIComponent(kind)}`),
  );
}

/** DELETE a stored credential → presence `false`. */
export async function deleteCredential(
  account: string,
  kind: CredentialKind,
): Promise<CredentialPresence> {
  return CredentialPresenceSchema.parse(
    await request(
      `/wizard/credentials/${encodeURIComponent(account)}/${encodeURIComponent(kind)}`,
      { method: 'DELETE' },
    ),
  );
}
