import { describe, expect, it } from 'vitest';
import { MAILORDOMO } from './index';

describe('shared smoke', () => {
  it('exports the package marker', () => {
    expect(MAILORDOMO).toBe('mailordomo');
  });
});
