import { describe, expect, it } from 'vitest';
import { renderHeaderSignalMessage, renderTrackSignalMessage } from './render.js';

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

describe('renderHeaderSignalMessage', () => {
  it('handles 0 papers case with a friendly message', () => {
    const grouped = new Map();
    const r = renderHeaderSignalMessage('2026-02-08', grouped);
    expect(r.text).toContain('No matching papers today');
  });
});
