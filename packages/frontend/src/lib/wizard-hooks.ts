/**
 * React Query hooks for the setup wizard (PLAN.md §7 Phase 8 / D33). Like `today-hooks`, the query/
 * mutation wiring (keys + invalidation) lives here so components stay declarative. After any config
 * write we invalidate `['wizard','config']` plus the affected list (`mailboxes` / `repos`) so the
 * advanced view + done summary refetch.
 *
 * GOLDEN RULE #4: a password/secret rides ONLY as a transient mutation VARIABLE (the request body) and
 * is dropped once the mutation settles — these hooks never read it back, never store it in a key, and
 * every `onSuccess` reads only the SECRET-FREE response (presence booleans / identity). Components that
 * collect a secret clear their form state and `reset()` the mutation after submit (see `MailboxStep`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddMailboxRequest,
  AddProjectRequest,
  CredentialKind,
  LinkRepoRequest,
  StoreCredentialRequest,
  UpdateMailboxRequest,
} from '@mailordomo/shared';
import {
  addMailbox,
  createProject,
  deleteCredential,
  deleteMailbox,
  fetchCredentialPresence,
  fetchMailboxes,
  fetchPresets,
  fetchRepos,
  fetchWizardConfig,
  fetchWizardHealth,
  fetchWizardProjects,
  linkRepo,
  pullRepo,
  queryKeys,
  storeCredential,
  testConnection,
  updateMailbox,
} from './api';

/* --------------------------------- queries ----------------------------------- */

/** Provider presets are static data — cache them for the session. */
export function usePresets() {
  return useQuery({
    queryKey: queryKeys.wizard.presets,
    queryFn: fetchPresets,
    staleTime: Infinity,
  });
}

/** The Claude health probe. `enabled` lets the health step gate the call until it is shown. */
export function useWizardHealth(enabled = true) {
  return useQuery({
    queryKey: queryKeys.wizard.health,
    queryFn: fetchWizardHealth,
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useWizardConfig() {
  return useQuery({ queryKey: queryKeys.wizard.config, queryFn: fetchWizardConfig });
}

export function useWizardProjects() {
  return useQuery({ queryKey: queryKeys.wizard.projects, queryFn: fetchWizardProjects });
}

export function useMailboxes() {
  return useQuery({ queryKey: queryKeys.wizard.mailboxes, queryFn: fetchMailboxes });
}

export function useRepos() {
  return useQuery({ queryKey: queryKeys.wizard.repos, queryFn: fetchRepos });
}

/** Whether a credential slot is populated — presence boolean only, never the value. */
export function useCredentialPresence(account: string, kind: CredentialKind, enabled = true) {
  return useQuery({
    queryKey: queryKeys.wizard.credential(account, kind),
    queryFn: () => fetchCredentialPresence(account, kind),
    enabled: enabled && account.length > 0,
  });
}

/* -------------------------------- mutations ---------------------------------- */

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddProjectRequest) => createProject(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.config });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.projects });
    },
  });
}

export function useAddMailbox() {
  const qc = useQueryClient();
  return useMutation({
    // The body carries the write-only password; the response (and everything below) is secret-free.
    mutationFn: (body: AddMailboxRequest) => addMailbox(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.config });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.mailboxes });
    },
  });
}

export function useUpdateMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: UpdateMailboxRequest }) =>
      updateMailbox(vars.id, vars.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.config });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.mailboxes });
    },
  });
}

/** Remove a mailbox (config entry + both Keychain credential slots); refresh the config + list. */
export function useDeleteMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMailbox(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.config });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.mailboxes });
    },
  });
}

/** Read-only connection test — no cache writes; the caller renders `{ ok, reason }`. */
export function useTestConnection() {
  return useMutation({ mutationFn: (id: string) => testConnection(id) });
}

export function useLinkRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LinkRepoRequest) => linkRepo(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.config });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.repos });
    },
  });
}

export function usePullRepo() {
  return useMutation({ mutationFn: (id: string) => pullRepo(id) });
}

export function useStoreCredential() {
  const qc = useQueryClient();
  return useMutation({
    // `body.secret` is write-only; `onSuccess` reads only the secret-free presence response.
    mutationFn: (body: StoreCredentialRequest) => storeCredential(body),
    onSuccess: (presence) => {
      void qc.invalidateQueries({
        queryKey: queryKeys.wizard.credential(presence.account, presence.kind),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.mailboxes });
    },
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { account: string; kind: CredentialKind }) =>
      deleteCredential(vars.account, vars.kind),
    onSuccess: (presence) => {
      void qc.invalidateQueries({
        queryKey: queryKeys.wizard.credential(presence.account, presence.kind),
      });
      void qc.invalidateQueries({ queryKey: queryKeys.wizard.mailboxes });
    },
  });
}
