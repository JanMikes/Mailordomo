/**
 * Wizard step 5 — done. A summary of what was configured: the project, the mailbox (with credential
 * PRESENCE ticks, never the secret), the repo (if linked), and Claude's health. "Go to Today" hands
 * off to the command center.
 */
import { CircleCheck, FolderGit2, ListTodo, Mail, Sparkles } from 'lucide-react';

import { useNav } from '@/lib/navigation';
import { useWizardHealth } from '@/lib/wizard-hooks';
import { PresenceTick, StepFrame, WizardFooter } from '../parts';
import type { StepProps } from '../types';

export function DoneStep({ data, back }: StepProps) {
  const nav = useNav();
  const health = useWizardHealth();

  return (
    <StepFrame
      title="You're set up"
      description="Here's what's configured. You can revisit Setup any time to add more."
      footer={
        <WizardFooter onBack={back} onNext={() => nav.goTo('today')} nextLabel="Go to Today" />
      }
    >
      <div className="space-y-2">
        <SummaryRow
          Icon={ListTodo}
          label="Project"
          value={data.project?.name ?? '—'}
          ok={data.project !== null}
        />

        <div className="bg-card flex items-start gap-2.5 rounded-lg border p-3">
          <Mail className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              {data.mailbox?.mailbox.address ?? 'No mailbox added'}
            </p>
            {data.mailbox && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <PresenceTick label="IMAP password" present={data.mailbox.credentials.imap} />
                <PresenceTick label="SMTP password" present={data.mailbox.credentials.smtp} />
              </div>
            )}
          </div>
          {data.mailbox && (
            <CircleCheck className="text-promise-deliver size-4 shrink-0" aria-hidden />
          )}
        </div>

        <SummaryRow
          Icon={FolderGit2}
          label="Repo"
          value={data.repo ? data.repo.pointer.name : 'Skipped'}
          ok={data.repo !== null}
        />

        <SummaryRow
          Icon={Sparkles}
          label="Claude"
          value={health.data ? health.data.detail : health.isLoading ? 'Checking…' : 'Unknown'}
          ok={health.data?.ok ?? false}
        />
      </div>
    </StepFrame>
  );
}

function SummaryRow({
  Icon,
  label,
  value,
  ok,
}: {
  Icon: typeof Mail;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="bg-card flex items-center gap-2.5 rounded-lg border p-3">
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="text-muted-foreground w-16 shrink-0 text-xs font-medium">{label}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{value}</span>
      {ok && <CircleCheck className="text-promise-deliver size-4 shrink-0" aria-hidden />}
    </div>
  );
}
