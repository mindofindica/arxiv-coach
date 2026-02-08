import { describe, expect, it } from 'vitest';
import { truncateForSignal } from './truncate.js';

describe('truncateForSignal', () => {
  it('does not truncate when under limit', () => {
    const r = truncateForSignal('hello', 10);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('hello');
  });

  it('truncates to the limit', () => {
    const r = truncateForSignal('x'.repeat(100), 50);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(50);
  });

  it('includes truncation note when there is room', () => {
    const r = truncateForSignal('x'.repeat(10000), 300);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(300);
    expect(r.text).toContain('Truncated');
  });
});
