/**
 * Connected-mailboxes management — the read/manage half of the setup flow (the wizard only ADDS). Lists
 * every configured mailbox with its endpoints + credential PRESENCE, and lets the user TEST the
 * connection, EDIT its endpoints / rotate its password, or REMOVE it (config entry + stored secrets).
 *
 * GOLDEN RULE #4: passwords are write-only inbound fields here too — entered in a transient field,
 * PATCHed to the backend, cleared on success, and NEVER read back. The list renders presence ticks
 * only, never a secret. GOLDEN RULE #1: nothing here sends; `test-connection` is a read-only IMAP login.
 */
import { useState } from 'react';
import { Mail, Pencil, Plug, Trash2, X } from 'lucide-react';
import type {
  MailboxConfig,
  MailboxConfigResponse,
  UpdateMailboxRequest,
} from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useDeleteMailbox,
  useMailboxes,
  useTestConnection,
  useUpdateMailbox,
} from '@/lib/wizard-hooks';
import { ErrorLine, LabeledInput, PresenceTick, ResultBanner, WizardCheckbox } from './parts';

export function MailboxList() {
  const mailboxes = useMailboxes();

  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-sm font-medium">Connected mailboxes</h2>
      {mailboxes.isPending ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : mailboxes.isError ? (
        <ErrorLine
          message={
            mailboxes.error instanceof Error ? mailboxes.error.message : 'Could not load mailboxes'
          }
        />
      ) : mailboxes.data.length === 0 ? (
        <Card className="text-muted-foreground gap-1 py-6 text-center text-sm">
          No mailboxes connected yet. Add one with the wizard below.
        </Card>
      ) : (
        <div className="space-y-2">
          {mailboxes.data.map((entry) => (
            <MailboxRow key={entry.mailbox.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function MailboxRow({ entry }: { entry: MailboxConfigResponse }) {
  const { mailbox, credentials } = entry;
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const test = useTestConnection();
  const remove = useDeleteMailbox();

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <Mail className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{mailbox.address}</span>
          </div>
          <p className="text-muted-foreground text-xs">
            IMAP {mailbox.imap.host}:{mailbox.imap.port}
            {mailbox.imap.secure ? ' · TLS' : ''} · SMTP {mailbox.smtp.host}:{mailbox.smtp.port}
            {mailbox.smtp.secure ? ' · TLS' : ''}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <PresenceTick label="IMAP password" present={credentials.imap} />
            <PresenceTick label="SMTP password" present={credentials.smtp} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => test.mutate(mailbox.id)}
            disabled={test.isPending}
          >
            <Plug className="size-4" aria-hidden />
            Test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
          >
            {editing ? (
              <X className="size-4" aria-hidden />
            ) : (
              <Pencil className="size-4" aria-hidden />
            )}
            {editing ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      {test.data && (
        <ResultBanner
          ok={test.data.ok}
          message={test.data.ok ? 'Connection ok.' : test.data.reason}
        />
      )}
      {test.isError && (
        <ErrorLine message={test.error instanceof Error ? test.error.message : 'Test failed'} />
      )}

      {editing && <MailboxEditForm mailbox={mailbox} onDone={() => setEditing(false)} />}

      <div className="flex items-center justify-end gap-2 pt-1">
        {confirmRemove ? (
          <>
            <span className="text-muted-foreground mr-auto text-xs">
              Remove this mailbox and its stored passwords?
            </span>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              disabled={remove.isPending}
              onClick={() => remove.mutate(mailbox.id)}
            >
              <Trash2 className="size-4" aria-hidden />
              Confirm remove
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive gap-1.5"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </Button>
        )}
      </div>
      {remove.isError && (
        <ErrorLine
          message={remove.error instanceof Error ? remove.error.message : 'Remove failed'}
        />
      )}
    </Card>
  );
}

/**
 * Inline edit for one mailbox: its address + IMAP/SMTP endpoints, plus OPTIONAL new passwords (left
 * blank = keep the stored one). Submits a `UpdateMailboxRequest` PATCH; the password fields are
 * write-only and cleared on success.
 */
function MailboxEditForm({ mailbox, onDone }: { mailbox: MailboxConfig; onDone: () => void }) {
  const update = useUpdateMailbox();
  const [address, setAddress] = useState(mailbox.address);
  const [imapHost, setImapHost] = useState(mailbox.imap.host);
  const [imapPort, setImapPort] = useState(String(mailbox.imap.port));
  const [imapSecure, setImapSecure] = useState(mailbox.imap.secure);
  const [smtpHost, setSmtpHost] = useState(mailbox.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(mailbox.smtp.port));
  const [smtpSecure, setSmtpSecure] = useState(mailbox.smtp.secure);
  const [imapPassword, setImapPassword] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');

  function submit() {
    const patch: UpdateMailboxRequest = {
      address,
      imap: {
        host: imapHost,
        port: Number.parseInt(imapPort, 10),
        secure: imapSecure,
        user: mailbox.imap.user,
      },
      smtp: {
        host: smtpHost,
        port: Number.parseInt(smtpPort, 10),
        secure: smtpSecure,
        user: mailbox.smtp.user,
      },
      ...(imapPassword ? { imapPassword } : {}),
      ...(smtpPassword ? { smtpPassword } : {}),
    };
    update.mutate(
      { id: mailbox.id, patch },
      {
        onSuccess: () => {
          setImapPassword('');
          setSmtpPassword('');
          update.reset();
          onDone();
        },
      },
    );
  }

  return (
    <div className="bg-muted/40 space-y-4 rounded-lg p-4">
      <LabeledInput
        label="Email address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        autoComplete="off"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledInput
          label="IMAP host"
          value={imapHost}
          onChange={(e) => setImapHost(e.target.value)}
          autoComplete="off"
        />
        <LabeledInput
          label="IMAP port"
          type="number"
          value={imapPort}
          onChange={(e) => setImapPort(e.target.value)}
        />
      </div>
      <WizardCheckbox label="IMAP uses TLS" checked={imapSecure} onChange={setImapSecure} />
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledInput
          label="SMTP host"
          value={smtpHost}
          onChange={(e) => setSmtpHost(e.target.value)}
          autoComplete="off"
        />
        <LabeledInput
          label="SMTP port"
          type="number"
          value={smtpPort}
          onChange={(e) => setSmtpPort(e.target.value)}
        />
      </div>
      <WizardCheckbox label="SMTP uses TLS" checked={smtpSecure} onChange={setSmtpSecure} />
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledInput
          label="New IMAP password"
          type="password"
          value={imapPassword}
          onChange={(e) => setImapPassword(e.target.value)}
          placeholder="Leave blank to keep current"
          autoComplete="new-password"
          hint="Stored in the Keychain, never echoed back."
        />
        <LabeledInput
          label="New SMTP password"
          type="password"
          value={smtpPassword}
          onChange={(e) => setSmtpPassword(e.target.value)}
          placeholder="Leave blank to keep current"
          autoComplete="new-password"
        />
      </div>
      {update.isError && (
        <ErrorLine message={update.error instanceof Error ? update.error.message : 'Save failed'} />
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={
            update.isPending ||
            address.trim() === '' ||
            imapHost.trim() === '' ||
            smtpHost.trim() === ''
          }
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}
