/**
 * The Setup view (PROJECT.md §10, Phase 8 / D33). A guided WIZARD (project → mailbox → repo → Claude
 * health → done) AND an ADVANCED raw-config view — both reachable so a developer is never trapped. A
 * segmented control switches between them; the wizard is the default.
 *
 * GOLDEN RULE #4 lives in the children: passwords are entered in the mailbox step's transient state,
 * POSTed write-only to the local backend, and never persisted/echoed. Nothing here reads a secret back.
 */
import { useState } from 'react';
import { SlidersHorizontal, Wand2 } from 'lucide-react';

import { SegmentedControl } from './parts';
import { AdvancedConfig } from './advanced-config';
import { MailboxList } from './mailbox-list';
import { SetupWizard } from './setup-wizard';

type Mode = 'guided' | 'advanced';

export function SetupPage() {
  const [mode, setMode] = useState<Mode>('guided');

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
          <p className="text-muted-foreground text-sm">
            Connect a project, a mailbox, and your code. Sending always stays manual.
          </p>
        </div>
        <SegmentedControl<Mode>
          label="Setup mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'guided', label: 'Guided', Icon: Wand2 },
            { value: 'advanced', label: 'Advanced', Icon: SlidersHorizontal },
          ]}
        />
      </div>

      <MailboxList />

      {mode === 'guided' ? <SetupWizard /> : <AdvancedConfig />}
    </div>
  );
}
