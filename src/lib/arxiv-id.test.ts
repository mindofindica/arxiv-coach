import { describe, expect, it } from 'vitest';
import { parseArxivId } from './arxiv.js';

describe('parseArxivId edge cases', () => {
  it('handles idUrl without arxiv.org/abs prefix', () => {
    const r = parseArxivId('2502.12345v3');
    expect(r).toEqual({ arxivId: '2502.12345', version: 'v3' });
  });
});
