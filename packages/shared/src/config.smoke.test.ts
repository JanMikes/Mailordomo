/**
 * SMOKE — provider presets + config DTO privacy (PLAN.md §7 Phase 8, D33).
 *
 * Proves: the iCloud/Gmail preset hosts + ports are correct (load-bearing — the wizard prefills them);
 * every preset validates against its schema; and the STORED/RESPONSE config shapes are secret-free by
 * construction (Golden rule #4) — a smuggled password fails strict validation, and only the INBOUND
 * request DTOs carry a password field.
 */
import { describe, expect, it } from 'vitest';
import {
  AddMailboxRequestSchema,
  MailboxConfigSchema,
  PROVIDER_PRESETS,
  ProviderPresetSchema,
  StoreCredentialRequestSchema,
} from './config';

describe('PROVIDER_PRESETS', () => {
  it('iCloud has the correct IMAP/SMTP hosts + ports', () => {
    const icloud = PROVIDER_PRESETS.find((p) => p.id === 'icloud');
    expect(icloud).toBeDefined();
    expect(icloud?.imap).toEqual({ host: 'imap.mail.me.com', port: 993, secure: true });
    expect(icloud?.smtp).toEqual({ host: 'smtp.mail.me.com', port: 587, secure: false });
    expect(icloud?.guidance).toMatch(/app-specific password/i);
  });

  it('Gmail has the correct IMAP/SMTP hosts + ports (OAuth2 deferred → app password)', () => {
    const gmail = PROVIDER_PRESETS.find((p) => p.id === 'gmail');
    expect(gmail?.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(gmail?.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(gmail?.guidance).toMatch(/app password/i);
  });

  it('every preset validates against the schema; ids are unique', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => ProviderPresetSchema.parse(preset)).not.toThrow();
    }
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('custom');
  });
});

describe('config DTO privacy (Golden rule #4)', () => {
  it('the STORED mailbox shape has no password field (a smuggled one is rejected)', () => {
    // `.parse(unknown)` accepts any object at the type level; the STRICT schema rejects the extra
    // `password` key at runtime — which is exactly the privacy guarantee.
    expect(() =>
      MailboxConfigSchema.parse({
        id: 'm1',
        projectId: 'p1',
        address: 'you@me.com',
        imap: { host: 'h', port: 993, secure: true, user: 'u' },
        smtp: { host: 'h', port: 587, secure: false, user: 'u' },
        password: 'leak',
      }),
    ).toThrow();
  });

  it('only the INBOUND request DTOs accept a secret', () => {
    // AddMailboxRequest accepts imapPassword as an inbound-only field …
    const req = AddMailboxRequestSchema.parse({
      projectId: 'p1',
      address: 'you@me.com',
      imap: { host: 'h', port: 993, secure: true, user: 'u' },
      smtp: { host: 'h', port: 587, secure: false, user: 'u' },
      imapPassword: 'app-pw',
    });
    expect(req.imapPassword).toBe('app-pw');
    // … and StoreCredentialRequest carries the generic secret.
    expect(
      StoreCredentialRequestSchema.parse({ account: 'm1', kind: 'imap', secret: 's' }).secret,
    ).toBe('s');
  });
});
