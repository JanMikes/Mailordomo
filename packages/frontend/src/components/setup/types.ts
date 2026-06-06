/**
 * Shared types threaded through the setup-wizard steps (Phase 8 / D33). `WizardData` holds only
 * SECRET-FREE results — the created project, the mailbox response (credential PRESENCE booleans, never
 * the password), and the linked repo — so the carried wizard state can never hold a secret.
 */
import type { MailboxConfigResponse, ProjectConfig, RepoConfigResponse } from '@mailordomo/shared';

export interface WizardData {
  /** The project chosen/created in step 1 (mailboxes + repos attach to it). */
  readonly project: ProjectConfig | null;
  /** The saved mailbox — config + credential-presence booleans (NEVER a password). */
  readonly mailbox: MailboxConfigResponse | null;
  /** The linked repo (optional step) — shareable identity + machine-local clone/pull config. */
  readonly repo: RepoConfigResponse | null;
}

export interface StepProps {
  readonly data: WizardData;
  /** Merge a slice into the carried wizard data. */
  readonly patch: (next: Partial<WizardData>) => void;
  /** Advance to the next step. */
  readonly next: () => void;
  /** Return to the previous step. */
  readonly back: () => void;
}
