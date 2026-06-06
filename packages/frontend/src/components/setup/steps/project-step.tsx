/**
 * Wizard step 1 — name a project (employer/workspace). Mailboxes and repos attach to it. If projects
 * already exist (re-running the wizard to add a mailbox), they are selectable so the user isn't forced
 * to create a duplicate. Creating one POSTs `/api/wizard/projects`.
 */
import { useState } from 'react';
import { Check, FolderPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCreateProject, useWizardProjects } from '@/lib/wizard-hooks';
import { ErrorLine, LabeledInput, StepFrame, WizardFooter } from '../parts';
import type { StepProps } from '../types';

export function ProjectStep({ data, patch, next }: StepProps) {
  const projects = useWizardProjects();
  const create = useCreateProject();
  const [name, setName] = useState('');

  const selectedId = data.project?.id ?? null;
  const trimmed = name.trim();
  const existing = projects.data ?? [];

  function handleCreate() {
    if (trimmed.length === 0 || create.isPending) return;
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (project) => {
          patch({ project });
          setName('');
        },
      },
    );
  }

  return (
    <StepFrame
      title="Name your project"
      description="A project is an employer or workspace. Its mailboxes and repos live under it."
      footer={
        <WizardFooter onNext={next} nextDisabled={selectedId === null} nextLabel="Continue" />
      }
    >
      {existing.length > 0 && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium">Use an existing project</p>
          <div className="flex flex-wrap gap-2">
            {existing.map((project) => {
              const active = project.id === selectedId;
              return (
                <button
                  key={project.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => patch({ project })}
                  className={cn(
                    'focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2',
                    active
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {active && <Check className="size-3.5" aria-hidden />}
                  {project.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {existing.length > 0 && (
          <p className="text-muted-foreground text-xs font-medium">Or create a new one</p>
        )}
        <div className="flex items-end gap-2">
          <LabeledInput
            label="Project name"
            placeholder="e.g. Fontai"
            value={name}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
            className="flex-1"
          />
          <Button
            variant="outline"
            onClick={handleCreate}
            disabled={trimmed.length === 0 || create.isPending}
            className="gap-1.5"
          >
            <FolderPlus className="size-4" aria-hidden />
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
        {create.isError && (
          <ErrorLine
            message={
              create.error instanceof Error ? create.error.message : 'Could not create project'
            }
          />
        )}
      </div>

      {data.project && (
        <p className="text-promise-deliver flex items-center gap-1.5 text-sm">
          <Check className="size-4" aria-hidden />
          {`Project "${data.project.name}" is selected.`}
        </p>
      )}
    </StepFrame>
  );
}
