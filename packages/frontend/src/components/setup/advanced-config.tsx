/**
 * The "Advanced" view — never trap a dev (PROJECT.md §10). It shows the current SECRET-FREE
 * `MailordomoConfig` (projects → mailboxes → repos) verbatim so a developer can see exactly what's
 * configured, and explains WHERE credentials live (Keychain / `{mailbox}.env`) so they can edit the
 * raw files directly. Read-only for v1 — the config JSON and `{mailbox}.env` files on disk are the
 * editable source of truth.
 *
 * GOLDEN RULE #4: the config is secret-free by construction (the backend's `GET /api/wizard/config`
 * returns no passwords), so rendering it verbatim — even as raw JSON — can never expose a secret.
 */
import { FileCog, KeyRound, Loader2 } from 'lucide-react';

import { ErrorLine } from './parts';
import { useWizardConfig } from '@/lib/wizard-hooks';

export function AdvancedConfig() {
  const config = useWizardConfig();

  return (
    <div className="space-y-4">
      <div className="bg-muted/40 flex items-start gap-2.5 rounded-lg border p-4">
        <KeyRound className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="space-y-1 text-sm">
          <p className="font-medium">Where credentials live</p>
          <p className="text-muted-foreground leading-relaxed">
            Passwords and tokens are stored in your macOS Keychain (preferred), or in a per-mailbox{' '}
            <code className="font-mono text-xs">{'{mailbox}.env'}</code> file (gitignored). They are{' '}
            <strong>never</strong> written to this config, returned by the API, or shown here. See{' '}
            <code className="font-mono text-xs">.env.example</code> for the fallback file format.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
          <FileCog className="size-4" aria-hidden />
          Current config
          <span className="text-muted-foreground/60 font-normal">(secret-free, read-only)</span>
        </div>

        {config.isLoading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading config…
          </p>
        ) : config.isError ? (
          <ErrorLine
            message={config.error instanceof Error ? config.error.message : 'Could not load config'}
          />
        ) : config.data ? (
          <pre className="bg-muted/40 max-h-[28rem] overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">
            {JSON.stringify(config.data, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
