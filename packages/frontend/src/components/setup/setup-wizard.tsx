/**
 * The guided setup wizard (Phase 8 / D33): a 5-step stepper — project → mailbox → repo → Claude
 * health → done. It lifts the SECRET-FREE {@link WizardData} (created project / mailbox response /
 * repo) and threads it through the steps; forward navigation is gated by each step (you can't continue
 * past the project step without one). A password never enters this carried state — see `MailboxStep`.
 */
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import { CircleCheck, FolderGit2, ListTodo, Mail, Sparkles, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { DoneStep } from './steps/done-step';
import { HealthStep } from './steps/health-step';
import { MailboxStep } from './steps/mailbox-step';
import { ProjectStep } from './steps/project-step';
import { RepoStep } from './steps/repo-step';
import type { StepProps, WizardData } from './types';

interface StepDef {
  key: string;
  label: string;
  Icon: LucideIcon;
  Component: (props: StepProps) => ReactElement;
}

const STEPS: readonly StepDef[] = [
  { key: 'project', label: 'Project', Icon: ListTodo, Component: ProjectStep },
  { key: 'mailbox', label: 'Mailbox', Icon: Mail, Component: MailboxStep },
  { key: 'repo', label: 'Repo', Icon: FolderGit2, Component: RepoStep },
  { key: 'health', label: 'Claude', Icon: Sparkles, Component: HealthStep },
  { key: 'done', label: 'Done', Icon: CircleCheck, Component: DoneStep },
];

const EMPTY: WizardData = { project: null, mailbox: null, repo: null };

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<WizardData>(EMPTY);

  const patch = useCallback((next: Partial<WizardData>) => {
    setData((current) => ({ ...current, ...next }));
  }, []);
  const next = useCallback(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), []);
  const back = useCallback(() => setStep((s) => Math.max(s - 1, 0)), []);

  const Current = STEPS[step]?.Component ?? ProjectStep;
  const stepProps = useMemo<StepProps>(
    () => ({ data, patch, next, back }),
    [data, patch, next, back],
  );

  return (
    <div className="space-y-6">
      <StepRail current={step} onJump={(i) => i <= step && setStep(i)} />
      <Current {...stepProps} />
    </div>
  );
}

/** The horizontal progress rail. Completed/current steps are clickable (to jump back); future ones aren't. */
function StepRail({ current, onJump }: { current: number; onJump: (index: number) => void }) {
  return (
    <ol className="flex items-center gap-1.5">
      {STEPS.map((s, i) => {
        const active = i === current;
        const complete = i < current;
        const reachable = i <= current;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-1.5">
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={!reachable}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'focus-visible:ring-ring/50 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2',
                active
                  ? 'text-foreground'
                  : complete
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-muted-foreground/50 cursor-default',
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : complete
                      ? 'border-promise-deliver/40 bg-promise-deliver/10 text-promise-deliver'
                      : 'border-border',
                )}
              >
                {complete ? (
                  <CircleCheck className="size-3" aria-hidden />
                ) : (
                  <s.Icon className="size-3" aria-hidden />
                )}
              </span>
              <span className="truncate">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn('h-px flex-1', complete ? 'bg-promise-deliver/30' : 'bg-border')}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
