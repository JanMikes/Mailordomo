import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('frontend smoke', () => {
  it('App is a component function', () => {
    expect(typeof App).toBe('function');
  });
});
