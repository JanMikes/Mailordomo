/**
 * Wizard step 2 — add a mailbox. The user picks a provider PRESET (iCloud / Gmail / custom) which
 * auto-fills the IMAP + SMTP host/port/TLS, then fills the address, username, and password(s). Submit
 * POSTs `/api/wizard/mailboxes`.
 *
 * GOLDEN RULE #4 — THE GOVERNING CONSTRAINT HERE:
 *   - The password lives ONLY in transient React state, typed into `type="password"` +
 *     `autoComplete="off"` inputs. It is sent as the WRITE-ONLY `imapPassword`/`smtpPassword` body
 *     field to the LOCAL backend and is NEVER put in localStorage, a URL, a query key, or a log.
 *   - On a successful save we clear the password state AND `reset()` the mutation (dropping the
 *     retained mutation variables), so the secret survives nowhere. The saved view then shows credential
 *     PRESENCE ticks — the value can never be read back (the backend can't return it either).
 */
import { useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Mail, PlugZap } from 'lucide-react';
import type {
  AddMailboxRequest,
  MailboxConfigResponse,
  ProviderId,
  ProviderPreset,
} from '@mailordomo/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAddMailbox, usePresets, useTestConnection, useUpdateMailbox } from '@/lib/wizard-hooks';
import {
  ErrorLine,
  LabeledInput,
  PresenceTick,
  ResultBanner,
  SegmentedControl,
  StepFrame,
  WizardCheckbox,
  WizardFooter,
} from '../parts';
import type { StepProps } from '../types';

const SHORT_LABEL: Record<ProviderId, string> = {
  icloud: 'iCloud',
  gmail: 'Gmail',
  custom: 'Custom',
};

interface EndpointDraft {
  host: string;
  port: string;
  secure: boolean;
}

function endpointFromPreset(p: { host: string; port: number; secure: boolean }): EndpointDraft {
  return { host: p.host, port: String(p.port), secure: p.secure };
}

/** Parse a positive-integer port; `null` when blank/invalid. */
function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function MailboxStep({ data, patch, next, back }: StepProps) {
  // The mailbox already saved this session → the saved/confirmation view; otherwise the add form.
  if (data.mailbox) {
    return (
      <SavedMailbox
        mailbox={data.mailbox}
        onUpdated={(mailbox) => patch({ mailbox })}
        next={next}
        back={back}
      />
    );
  }
  return <AddMailboxForm data={data} patch={patch} back={back} />;
}

/* --------------------------------- add form ---------------------------------- */

function AddMailboxForm({ data, patch, back }: Pick<StepProps, 'data' | 'patch' | 'back'>) {
  const presets = usePresets();
  const add = useAddMailbox();

  const [presetId, setPresetId] = useState<ProviderId>('icloud');
  const [address, setAddress] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [imap, setImap] = useState<EndpointDraft>({ host: '', port: '993', secure: true });
  const [smtp, setSmtp] = useState<EndpointDraft>({ host: '', port: '587', secure: false });
  const [imapPassword, setImapPassword] = useState('');
  const [sameSmtpPassword, setSameSmtpPassword] = useState(true);
  const [smtpPassword, setSmtpPassword] = useState('');

  // Seed the endpoints from the default (first) preset once the presets load.
  const seeded = useRef(false);
  useEffect(() => {
    const list = presets.data;
    if (seeded.current || !list || list.length === 0) return;
    seeded.current = true;
    const first = list[0] as ProviderPreset;
    setPresetId(first.id);
    setImap(endpointFromPreset(first.imap));
    setSmtp(endpointFromPreset(first.smtp));
  }, [presets.data]);

  function selectPreset(id: ProviderId) {
    setPresetId(id);
    const preset = presets.data?.find((p) => p.id === id);
    if (preset) {
      setImap(endpointFromPreset(preset.imap));
      setSmtp(endpointFromPreset(preset.smtp));
    }
  }

  // The username defaults to (mirrors) the address until the user edits it explicitly.
  const effectiveUsername = usernameTouched ? username : address;
  const imapPort = parsePort(imap.port);
  const smtpPort = parsePort(smtp.port);

  const valid =
    /.+@.+/.test(address.trim()) &&
    effectiveUsername.trim().length > 0 &&
    imap.host.trim().length > 0 &&
    imapPort !== null &&
    smtp.host.trim().length > 0 &&
    smtpPort !== null &&
    imapPassword.length > 0 &&
    (sameSmtpPassword || smtpPassword.length > 0);

  const activePreset = presets.data?.find((p) => p.id === presetId);

  function handleSubmit() {
    if (!valid || imapPort === null || smtpPort === null || data.project === null) return;
    const user = effectiveUsername.trim();
    const body: AddMailboxRequest = {
      projectId: data.project.id,
      address: address.trim(),
      imap: { host: imap.host.trim(), port: imapPort, secure: imap.secure, user },
      smtp: { host: smtp.host.trim(), port: smtpPort, secure: smtp.secure, user },
      imapPassword,
      smtpPassword: sameSmtpPassword ? imapPassword : smtpPassword,
    };
    add.mutate(body, {
      onSuccess: (mailbox) => {
        patch({ mailbox });
        // GOLDEN RULE #4: wipe the secret from React state AND purge the retained mutation variables.
        setImapPassword('');
        setSmtpPassword('');
        add.reset();
      },
    });
  }

  if (presets.isLoading) {
    return (
      <StepFrame title="Add a mailbox" description="Pick your provider, then enter your login.">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading provider presets…
        </p>
      </StepFrame>
    );
  }

  return (
    <StepFrame
      title="Add a mailbox"
      description="Pick your provider to auto-fill the servers, then enter your login."
      footer={
        <WizardFooter
          onBack={back}
          onNext={handleSubmit}
          nextLabel={add.isPending ? 'Saving…' : 'Save mailbox'}
          nextDisabled={!valid}
          nextPending={add.isPending}
        />
      }
    >
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium">Provider</p>
        <SegmentedControl
          label="Provider"
          value={presetId}
          onChange={selectPreset}
          options={(presets.data ?? []).map((p) => ({
            value: p.id,
            label: SHORT_LABEL[p.id] ?? p.label,
          }))}
        />
        {activePreset && activePreset.guidance.length > 0 && (
          <p className="text-muted-foreground bg-muted/40 rounded-md px-3 py-2 text-xs leading-relaxed">
            {activePreset.guidance}
          </p>
        )}
      </div>

      <LabeledInput
        label="Email address"
        type="email"
        autoComplete="off"
        placeholder="you@me.com"
        value={address}
        invalid={address.length > 0 && !/.+@.+/.test(address.trim())}
        onChange={(e) => setAddress(e.target.value)}
      />

      <LabeledInput
        label="Username"
        autoComplete="off"
        placeholder="usually your full email address"
        hint="Used to log in to both IMAP and SMTP."
        value={effectiveUsername}
        onChange={(e) => {
          setUsernameTouched(true);
          setUsername(e.target.value);
        }}
      />

      <Separator />

      <EndpointFields legend="Incoming mail (IMAP)" value={imap} onChange={setImap} />
      <EndpointFields legend="Outgoing mail (SMTP)" value={smtp} onChange={setSmtp} />

      <Separator />

      {/* GOLDEN RULE #4: password inputs are type=password + autoComplete=off; value is transient state. */}
      <LabeledInput
        label="Password"
        type="password"
        autoComplete="off"
        placeholder="app-specific password"
        hint="Stored locally in your Keychain — never uploaded, never shown again."
        value={imapPassword}
        onChange={(e) => setImapPassword(e.target.value)}
      />
      <WizardCheckbox
        label="Use the same password for SMTP"
        checked={sameSmtpPassword}
        onChange={setSameSmtpPassword}
      />
      {!sameSmtpPassword && (
        <LabeledInput
          label="SMTP password"
          type="password"
          autoComplete="off"
          value={smtpPassword}
          onChange={(e) => setSmtpPassword(e.target.value)}
        />
      )}

      {add.isError && (
        <ErrorLine
          message={add.error instanceof Error ? add.error.message : 'Could not save the mailbox'}
        />
      )}
    </StepFrame>
  );
}

/** Host / port / TLS for one transport endpoint. */
function EndpointFields({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: EndpointDraft;
  onChange: (next: EndpointDraft) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-muted-foreground text-xs font-medium">{legend}</legend>
      <div className="flex gap-2">
        <LabeledInput
          label="Host"
          autoComplete="off"
          placeholder="imap.example.com"
          value={value.host}
          onChange={(e) => onChange({ ...value, host: e.target.value })}
          className="flex-1"
        />
        <LabeledInput
          label="Port"
          type="number"
          inputMode="numeric"
          min={1}
          value={value.port}
          invalid={parsePort(value.port) === null}
          onChange={(e) => onChange({ ...value, port: e.target.value })}
          className="w-24"
        />
      </div>
      <WizardCheckbox
        label="Use implicit TLS (off = STARTTLS, e.g. port 587)"
        checked={value.secure}
        onChange={(secure) => onChange({ ...value, secure })}
      />
    </fieldset>
  );
}

/* --------------------------------- saved view -------------------------------- */

function SavedMailbox({
  mailbox,
  onUpdated,
  next,
  back,
}: {
  mailbox: MailboxConfigResponse;
  onUpdated: (mailbox: MailboxConfigResponse) => void;
  next: () => void;
  back: () => void;
}) {
  const test = useTestConnection();
  const update = useUpdateMailbox();
  const [editingPassword, setEditingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [sameSmtp, setSameSmtp] = useState(true);

  const { mailbox: cfg, credentials } = mailbox;

  function savePassword() {
    if (newPassword.length === 0 || update.isPending) return;
    update.mutate(
      {
        id: cfg.id,
        // When "same for SMTP" is on, update both; otherwise update only IMAP (leave SMTP unchanged).
        patch: sameSmtp
          ? { imapPassword: newPassword, smtpPassword: newPassword }
          : { imapPassword: newPassword },
      },
      {
        onSuccess: (updated) => {
          onUpdated(updated);
          // GOLDEN RULE #4: clear the secret + purge the mutation's retained variables.
          setNewPassword('');
          setEditingPassword(false);
          update.reset();
        },
      },
    );
  }

  return (
    <StepFrame
      title="Mailbox saved"
      description="Your login is stored locally. Test the connection to confirm it works."
      footer={<WizardFooter onBack={back} onNext={next} nextLabel="Continue" />}
    >
      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Mail className="text-muted-foreground size-4" aria-hidden />
          <span className="font-medium">{cfg.address}</span>
        </div>
        <div className="text-muted-foreground grid gap-1 text-sm sm:grid-cols-2">
          <EndpointSummary
            label="IMAP"
            host={cfg.imap.host}
            port={cfg.imap.port}
            secure={cfg.imap.secure}
          />
          <EndpointSummary
            label="SMTP"
            host={cfg.smtp.host}
            port={cfg.smtp.port}
            secure={cfg.smtp.secure}
          />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
          <PresenceTick label="IMAP password" present={credentials.imap} />
          <PresenceTick label="SMTP password" present={credentials.smtp} />
        </div>
      </div>

      <div className="space-y-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => test.mutate(cfg.id)}
          disabled={test.isPending}
          className="gap-1.5"
        >
          {test.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <PlugZap className="size-4" aria-hidden />
          )}
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {test.data && <ResultBanner ok={test.data.ok} message={test.data.reason} />}
        {test.isError && (
          <ErrorLine
            message={test.error instanceof Error ? test.error.message : 'Connection test failed'}
          />
        )}
      </div>

      <Separator />

      {editingPassword ? (
        <div className="space-y-3">
          <LabeledInput
            label="New password"
            type="password"
            autoComplete="off"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <WizardCheckbox
            label="Use the same password for SMTP"
            checked={sameSmtp}
            onChange={setSameSmtp}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={savePassword}
              disabled={newPassword.length === 0 || update.isPending}
            >
              {update.isPending ? 'Saving…' : 'Save password'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setNewPassword('');
                setEditingPassword(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {update.isError && (
            <ErrorLine
              message={
                update.error instanceof Error ? update.error.message : 'Could not update password'
              }
            />
          )}
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditingPassword(true)}
          className="text-muted-foreground gap-1.5"
        >
          <KeyRound className="size-4" aria-hidden />
          Update password
        </Button>
      )}
    </StepFrame>
  );
}

function EndpointSummary({
  label,
  host,
  port,
  secure,
}: {
  label: string;
  host: string;
  port: number;
  secure: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-foreground/70 font-medium">{label}</span>
      <span className="tabular-nums">{`${host}:${port}`}</span>
      <Badge variant="outline" className="font-normal">
        {secure ? 'TLS' : 'STARTTLS'}
      </Badge>
    </span>
  );
}
