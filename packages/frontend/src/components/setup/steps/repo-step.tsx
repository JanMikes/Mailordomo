/**
 * Wizard step 3 (optional) — link a repo so Claude can answer repo-aware questions (PROJECT.md §10,
 * D13). Two modes: a LOCAL PATH (the maintainer's live clone, read via `--add-dir`) or a GIT URL with
 * an "actively pull" checkbox (a read-only mirror kept fresh on a schedule — for a non-maintainer).
 * The shareable identity is name + git_url; the local clone path stays machine-local (Golden rule #3).
 */
import { useState } from 'react';
import { FolderGit2, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { LinkRepoRequest, RepoConfigResponse } from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { useLinkRepo, usePullRepo } from '@/lib/wizard-hooks';
import {
  ErrorLine,
  LabeledInput,
  ResultBanner,
  SegmentedControl,
  StepFrame,
  WizardCheckbox,
  WizardFooter,
} from '../parts';
import type { StepProps } from '../types';

type RepoMode = 'local' | 'git-url';

export function RepoStep({ data, patch, next, back }: StepProps) {
  if (data.repo) {
    return (
      <SavedRepo repo={data.repo} onRelink={() => patch({ repo: null })} next={next} back={back} />
    );
  }
  return <LinkRepoForm data={data} patch={patch} next={next} back={back} />;
}

function LinkRepoForm({ data, patch, next, back }: StepProps) {
  const link = useLinkRepo();
  const [mode, setMode] = useState<RepoMode>('local');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [activePull, setActivePull] = useState(true);

  const valid =
    name.trim().length > 0 &&
    gitUrl.trim().length > 0 &&
    (mode === 'git-url' || localPath.trim().length > 0);

  function handleSubmit() {
    if (!valid || data.project === null) return;
    const body: LinkRepoRequest = {
      project_id: data.project.id,
      name: name.trim(),
      git_url: gitUrl.trim(),
      local_path: mode === 'local' ? localPath.trim() : undefined,
      active_pull: mode === 'git-url' ? activePull : false,
    };
    link.mutate(body, { onSuccess: (repo) => patch({ repo }) });
  }

  return (
    <StepFrame
      title="Link a repo (optional)"
      description="Give Claude your code for repo-aware answers. Skip this if you don't need it."
      footer={
        <WizardFooter
          onBack={back}
          onNext={handleSubmit}
          nextLabel={link.isPending ? 'Linking…' : 'Link repo'}
          nextDisabled={!valid}
          nextPending={link.isPending}
          secondary={
            <Button variant="ghost" size="sm" onClick={next}>
              Skip for now
            </Button>
          }
        />
      }
    >
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium">Mode</p>
        <SegmentedControl<RepoMode>
          label="Repo mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'local', label: 'Local path', Icon: FolderGit2 },
            { value: 'git-url', label: 'Git URL + pull', Icon: GitBranch },
          ]}
        />
        <p className="text-muted-foreground text-xs">
          {mode === 'local'
            ? 'Reads your live clone directly — best if you maintain this repo on this machine.'
            : 'Keeps a read-only mirror; enable "actively pull" to refresh it on a schedule.'}
        </p>
      </div>

      <LabeledInput
        label="Name"
        autoComplete="off"
        placeholder="e.g. fontai/api"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <LabeledInput
        label="Git URL"
        autoComplete="off"
        placeholder="git@github.com:org/repo.git"
        hint="The shareable identity for this repo (sent to the metadata service as name + URL only)."
        value={gitUrl}
        onChange={(e) => setGitUrl(e.target.value)}
      />

      {mode === 'local' ? (
        <LabeledInput
          label="Local path"
          autoComplete="off"
          placeholder="/Users/you/code/repo"
          hint="Absolute path to your clone on this machine. Stays local — never sent anywhere."
          value={localPath}
          onChange={(e) => setLocalPath(e.target.value)}
        />
      ) : (
        <WizardCheckbox
          label="Actively pull (keep the mirror fresh on a schedule)"
          checked={activePull}
          onChange={setActivePull}
        />
      )}

      {link.isError && (
        <ErrorLine
          message={link.error instanceof Error ? link.error.message : 'Could not link the repo'}
        />
      )}
    </StepFrame>
  );
}

function SavedRepo({
  repo,
  onRelink,
  next,
  back,
}: {
  repo: RepoConfigResponse;
  onRelink: () => void;
  next: () => void;
  back: () => void;
}) {
  const pull = usePullRepo();
  const { pointer, local } = repo;

  return (
    <StepFrame
      title="Repo linked"
      description="Claude can now read this repo for technical answers."
      footer={<WizardFooter onBack={back} onNext={next} nextLabel="Continue" />}
    >
      <div className="bg-card space-y-2 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <FolderGit2 className="text-muted-foreground size-4" aria-hidden />
          <span className="font-medium">{pointer.name}</span>
        </div>
        <p className="text-muted-foreground text-sm break-all">{pointer.git_url}</p>
        <p className="text-muted-foreground text-xs break-all">
          {`Local: ${local.local_path}`}
          {local.active_pull && ' · actively pulling'}
        </p>
      </div>

      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => pull.mutate(pointer.id)}
          disabled={pull.isPending}
          className="gap-1.5"
        >
          {pull.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-4" aria-hidden />
          )}
          {pull.isPending ? 'Pulling…' : 'Pull now'}
        </Button>
        {pull.data && <ResultBanner ok={pull.data.ok} message={pull.data.reason} />}
        {pull.isError && (
          <ErrorLine message={pull.error instanceof Error ? pull.error.message : 'Pull failed'} />
        )}
      </div>

      <Button variant="ghost" size="sm" onClick={onRelink} className="text-muted-foreground">
        Link a different repo
      </Button>
    </StepFrame>
  );
}
