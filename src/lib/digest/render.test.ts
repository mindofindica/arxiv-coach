import { describe, expect, it } from 'vitest';
import { renderTrackSignalMessage } from './render.js';

describe('renderTrackSignalMessage', () => {
  it('includes title and link when present', () => {
    const r = renderTrackSignalMessage('Agents / Planning', [
      {
        arxivId: '2502.1',
        title: 'A Paper',
        abstract: 'Some abstract',
        updatedAt: '2026-02-08T00:00:00Z',
        absUrl: 'http://arxiv.org/abs/2502.1',
        pdfUrl: null,
        score: 3,
        matchedTerms: ['plan'],
        trackName: 'Agents / Planning',
      },
    ]);
    expect(r.text).toContain('A Paper');
    expect(r.text).toContain('http://arxiv.org/abs/2502.1');
  });
});
