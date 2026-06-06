/**
 * Wizard step 4 — Claude binary health. Calls `GET /api/wizard/health` (resolve + `--version`, a cheap
 * probe that makes no model call) and shows green/red with the detail. This is what makes drafting and
 * repo-aware answers work, so the user confirms it before finishing.
 */
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useWizardHealth } from '@/lib/wizard-hooks';
import { ResultBanner, StepFrame, WizardFooter } from '../parts';
import type { StepProps } from '../types';

export function HealthStep({ next, back }: StepProps) {
  const health = useWizardHealth();

  return (
    <StepFrame
      title="Check Claude"
      description="Claude is the engine — it triages, drafts, and answers. Let's confirm the binary runs."
      footer={<WizardFooter onBack={back} onNext={next} nextLabel="Continue" />}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="text-muted-foreground size-4" aria-hidden />
        <span className="text-sm font-medium">Claude binary</span>
      </div>

      {health.isLoading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Checking…
        </p>
      ) : health.isError ? (
        <ResultBanner
          ok={false}
          message={health.error instanceof Error ? health.error.message : 'Health check failed'}
        />
      ) : health.data ? (
        <ResultBanner ok={health.data.ok} message={health.data.detail} />
      ) : null}

      <Button
        variant="outline"
        size="sm"
        onClick={() => void health.refetch()}
        disabled={health.isFetching}
        className="gap-1.5"
      >
        <RefreshCw className="size-4" aria-hidden />
        Re-check
      </Button>

      {health.data && !health.data.ok && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Install the Claude CLI or set <code className="font-mono">CLAUDE_BIN</code> to its path,
          then re-check. You can still finish setup — drafting just won&rsquo;t work until Claude
          resolves.
        </p>
      )}
    </StepFrame>
  );
}
