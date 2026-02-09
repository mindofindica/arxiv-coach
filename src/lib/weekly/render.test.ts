import { describe, expect, it } from 'vitest';
import {
  renderShortlistMessage,
  renderWeeklyHeaderMessage,
  renderRelatedMessage,
  renderQuietWeekMessage,
} from './render.js';
import type { WeeklyCandidate } from './select.js';

describe('renderShortlistMessage', () => {
  const mockCandidate = (rank: number): WeeklyCandidate => ({
    rank,
    arxivId: `2602.0${rank}`,
    title: `Paper Title ${rank}`,
    authors: ['Author One', 'Author Two'],
    abstract: 'This is a paper about something very interesting and relevant to agents.',
    score: 5 - rank + 1,
    tracks: ['Agents / Planning', 'LLM Engineering'],
    absUrl: `https://arxiv.org/abs/2602.0${rank}`,
    pdfUrl: null,
  });

  it('renders shortlist header correctly', () => {
    const candidates = [mockCandidate(1), mockCandidate(2)];
    const result = renderShortlistMessage('2026-W07', candidates);
    
    expect(result.text).toContain('arxiv-coach — weekly shortlist (2026-W07)');
    expect(result.text).toContain('Top papers this week');
  });

  it('includes all candidate details', () => {
    const candidates = [mockCandidate(1)];
    const result = renderShortlistMessage('2026-W07', candidates);
    
    expect(result.text).toContain('1. Paper Title 1');
    expect(result.text).toContain('https://arxiv.org/abs/2602.01');
    expect(result.text).toContain('score: 5');
    expect(result.text).toContain('Agents / Planning');
  });

  it('includes call to action', () => {
    const candidates = [mockCandidate(1)];
    const result = renderShortlistMessage('2026-W07', candidates);
    
    expect(result.text).toContain('Reply with a number');
    expect(result.text).toContain('auto-select');
  });

  it('handles empty candidates with quiet week message', () => {
    const result = renderShortlistMessage('2026-W07', []);
    
    expect(result.text).toContain('Quiet week');
    expect(result.text).toContain('no papers matched');
    expect(result.text).not.toContain('Reply with a number');
  });

  it('truncates long abstracts', () => {
    const candidate = mockCandidate(1);
    candidate.abstract = 'A'.repeat(500);
    
    const result = renderShortlistMessage('2026-W07', [candidate]);
    
    expect(result.text.length).toBeLessThan(3000);
    expect(result.text).toContain('…');
  });
});

describe('renderWeeklyHeaderMessage', () => {
  it('renders header with paper details', () => {
    const paper = {
      title: 'Amazing Paper About Agents',
      absUrl: 'https://arxiv.org/abs/2602.01234',
      score: 5,
      tracks: ['Agents'],
      hasFullText: true,
    };

    const result = renderWeeklyHeaderMessage('2026-W07', paper);
    
    expect(result.text).toContain('arxiv-coach — weekly deep dive (2026-W07)');
    expect(result.text).toContain("This week's paper");
    expect(result.text).toContain('**Amazing Paper About Agents**');
    expect(result.text).toContain('https://arxiv.org/abs/2602.01234');
    expect(result.text).toContain('score: 5');
    expect(result.text).toContain('Agents');
  });

  it('warns when no full text available', () => {
    const paper = {
      title: 'Abstract-Only Paper',
      absUrl: null,
      score: 3,
      tracks: ['LLM'],
      hasFullText: false,
    };

    const result = renderWeeklyHeaderMessage('2026-W07', paper);
    
    expect(result.text).toContain('⚠️ Full text unavailable');
    expect(result.text).toContain('abstract only');
  });

  it('does not warn when full text is available', () => {
    const paper = {
      title: 'Full Paper',
      absUrl: null,
      score: 3,
      tracks: ['LLM'],
      hasFullText: true,
    };

    const result = renderWeeklyHeaderMessage('2026-W07', paper);
    
    expect(result.text).not.toContain('⚠️');
    expect(result.text).not.toContain('abstract only');
  });
});

describe('renderRelatedMessage', () => {
  it('renders related papers list', () => {
    const related = [
      { arxivId: '2602.01', title: 'Related Paper 1', score: 4, tracks: ['Track A'] },
      { arxivId: '2602.02', title: 'Related Paper 2', score: 3, tracks: ['Track B'] },
    ];

    const result = renderRelatedMessage(related);
    
    expect(result.text).toContain('Related papers this week');
    expect(result.text).toContain('Related Paper 1');
    expect(result.text).toContain('score: 4');
    expect(result.text).toContain('Related Paper 2');
  });

  it('handles empty related papers', () => {
    const result = renderRelatedMessage([]);
    
    expect(result.text).toContain('No other papers matched');
  });

  it('truncates to 5 papers with count of remaining', () => {
    const related = Array.from({ length: 8 }, (_, i) => ({
      arxivId: `2602.0${i}`,
      title: `Paper ${i}`,
      score: i,
      tracks: ['Track'],
    }));

    const result = renderRelatedMessage(related);
    
    expect(result.text).toContain('Paper 0');
    expect(result.text).toContain('Paper 4');
    expect(result.text).not.toContain('Paper 5');
    expect(result.text).toContain('...and 3 more');
  });
});

describe('renderQuietWeekMessage', () => {
  it('renders quiet week message correctly', () => {
    const result = renderQuietWeekMessage('2026-W07');
    
    expect(result.text).toContain('arxiv-coach — weekly deep dive (2026-W07)');
    expect(result.text).toContain('No papers matched');
    expect(result.text).toContain('Take a break');
  });
});
