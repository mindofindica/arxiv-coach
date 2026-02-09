import { describe, expect, it } from 'vitest';
import { renderHeaderSignalMessage, renderTrackSignalMessage, renderDailyMarkdown } from './render.js';
import type { SelectedPaper } from './select.js';

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
        llmScore: null,
      },
    ]);
    expect(r.text).toContain('A Paper');
    expect(r.text).toContain('http://arxiv.org/abs/2502.1');
  });

  it('shows relevance score when llmScore is present', () => {
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
        llmScore: 4,
      },
    ]);
    expect(r.text).toContain('relevance: 4/5');
    expect(r.text).toContain('matched: plan');
  });

  it('omits relevance when llmScore is null', () => {
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
        llmScore: null,
      },
    ]);
    expect(r.text).not.toContain('relevance:');
    expect(r.text).toContain('matched: plan');
  });
});

describe('renderHeaderSignalMessage', () => {
  it('handles 0 papers case with a friendly message', () => {
    const grouped = new Map();
    const r = renderHeaderSignalMessage('2026-02-08', grouped);
    expect(r.text).toContain('No matching papers today');
  });
});

describe('renderDailyMarkdown', () => {
  it('shows relevance score in markdown when llmScore is present', () => {
    const grouped = new Map<string, SelectedPaper[]>();
    grouped.set('Agents', [
      {
        arxivId: '2502.1',
        title: 'Agent Paper',
        abstract: 'About agents',
        updatedAt: '2026-02-08T00:00:00Z',
        absUrl: 'http://arxiv.org/abs/2502.1',
        pdfUrl: null,
        score: 5,
        matchedTerms: ['agent'],
        trackName: 'Agents',
        llmScore: 5,
      },
    ]);
    const md = renderDailyMarkdown('2026-02-08', grouped);
    expect(md).toContain('score: 5 • relevance: 5/5 • matched: agent');
  });

  it('omits relevance in markdown when llmScore is null', () => {
    const grouped = new Map<string, SelectedPaper[]>();
    grouped.set('Agents', [
      {
        arxivId: '2502.1',
        title: 'Agent Paper',
        abstract: 'About agents',
        updatedAt: '2026-02-08T00:00:00Z',
        absUrl: 'http://arxiv.org/abs/2502.1',
        pdfUrl: null,
        score: 5,
        matchedTerms: ['agent'],
        trackName: 'Agents',
        llmScore: null,
      },
    ]);
    const md = renderDailyMarkdown('2026-02-08', grouped);
    expect(md).toContain('score: 5 • matched: agent');
    expect(md).not.toContain('relevance:');
  });
});
