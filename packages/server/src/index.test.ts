import { describe, expect, it } from 'vitest';
import { SERVER_NAME } from './index';

describe('server smoke', () => {
  it('exports the service name', () => {
    expect(SERVER_NAME).toBe('mailordomo-metadata-service');
  });
});
