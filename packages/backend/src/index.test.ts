import { describe, expect, it } from 'vitest';
import { BACKEND_NAME } from './index';
import { DAEMON_NAME } from './daemon/index';
import { SEND_MODULE, assertManualSendOnly } from './smtp/send';

describe('backend smoke', () => {
  it('exports the package marker', () => {
    expect(BACKEND_NAME).toBe('mailordomo-backend');
  });

  it('keeps daemon and send-path module markers distinct', () => {
    expect(DAEMON_NAME).not.toBe(SEND_MODULE);
    expect(assertManualSendOnly()).toBe(SEND_MODULE);
  });
});
