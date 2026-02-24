import { describe, expect, it } from 'vitest';

import { renderSearchMessage, renderSearchCompact } from './render-search.js';
import type { SearchResponse } from './search-papers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<{
  arxivId: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  llmScore: number | null;
  llmReasoning: string | null;
  keywordScore: number;
  tracks: string[];
  absUrl: string;
}>): SearchResponse['results'][0] {
  return {
    arxivId: '2501.12345',
    title: 'Test Paper Title',
    excerpt: 'This is the abstract excerpt for the test paper.',
    publishedAt: '2026-01-15T00:00:00Z',
    llmScore: 4,
    llmReasoning: 'Good paper',
    keywordScore: 75,
    tracks: ['LLM Efficiency'],
    absUrl: 'https://arxiv.org/abs/2501.12345',
    ...overrides,
  };
}

function makeResponse(overrides: Partial<SearchResponse>): SearchResponse {
  return {
    kind: 'searchResults',
    query: 'speculative decoding',
    count: 0,
    results: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('renderSearchMessage — empty results', () => {
  it('shows "no papers found" message', () => {
    const response = makeResponse({ query: 'protein folding', count: 0, results: [] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('No papers found');
    expect(text).toContain('protein folding');
  });

  it('includes search query in header', () => {
    const response = makeResponse({ query: 'my test query', count: 0, results: [] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('my test query');
  });

  it('includes helpful tip for empty results', () => {
    const response = makeResponse({ query: 'nothing', count: 0, results: [] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('/weekly');
  });
});

describe('renderSearchMessage — single result', () => {
  it('shows result count', () => {
    const result = makeResult({});
    const response = makeResponse({ query: 'speculative', count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('1 result');
  });

  it('shows title', () => {
    const result = makeResult({ title: 'SpecTr: Fast Speculative Decoding' });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('SpecTr: Fast Speculative Decoding');
  });

  it('shows LLM score', () => {
    const result = makeResult({ llmScore: 5 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('5/5');
    expect(text).toContain('🔥');
  });

  it('shows track', () => {
    const result = makeResult({ tracks: ['LLM Efficiency'] });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('LLM Efficiency');
  });

  it('shows abstract excerpt', () => {
    const result = makeResult({ excerpt: 'We propose a new method for fast inference.' });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('We propose a new method');
  });

  it('shows arXiv URL', () => {
    const result = makeResult({ absUrl: 'https://arxiv.org/abs/2501.12345' });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('https://arxiv.org/abs/2501.12345');
  });

  it('shows footer with /weekly tip', () => {
    const result = makeResult({});
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('/weekly');
    expect(text).toContain('/reading-list');
  });
});

describe('renderSearchMessage — score formatting', () => {
  it('uses 🔥 for score 5', () => {
    const result = makeResult({ llmScore: 5 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('🔥');
  });

  it('uses ⭐ for score 4', () => {
    const result = makeResult({ llmScore: 4 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('⭐');
  });

  it('uses 📌 for score 3', () => {
    const result = makeResult({ llmScore: 3 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('📌');
  });

  it('shows kw score when no llm score', () => {
    const result = makeResult({ llmScore: null, keywordScore: 88 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('kw:88');
  });

  it('handles null llmScore gracefully', () => {
    const result = makeResult({ llmScore: null, keywordScore: 0 });
    const response = makeResponse({ count: 1, results: [result] });
    const { text } = renderSearchMessage(response);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('renderSearchMessage — multiple results', () => {
  it('numbers results 1, 2, 3', () => {
    const results = [
      makeResult({ arxivId: '2501.00001', title: 'Paper Alpha' }),
      makeResult({ arxivId: '2501.00002', title: 'Paper Beta' }),
      makeResult({ arxivId: '2501.00003', title: 'Paper Gamma' }),
    ];
    const response = makeResponse({ count: 3, results });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('1. Paper Alpha');
    expect(text).toContain('2. Paper Beta');
    expect(text).toContain('3. Paper Gamma');
  });

  it('shows plural "results" for multiple', () => {
    const results = [makeResult({}), makeResult({ arxivId: '2501.00002' })];
    const response = makeResponse({ count: 2, results });
    const { text } = renderSearchMessage(response);
    expect(text).toContain('2 results');
  });

  it('shows singular "result" for one', () => {
    const response = makeResponse({ count: 1, results: [makeResult({})] });
    const { text } = renderSearchMessage(response);
    expect(text).toMatch(/1 result[^s]/);
  });
});

describe('renderSearchMessage — truncation', () => {
  it('does not return excessively long messages', () => {
    // Create results with very long titles and excerpts
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({
        arxivId: `2501.0000${i}`,
        title: 'A Very Long Paper Title That Goes On And On And On About Deep Learning Methods',
        excerpt: 'x'.repeat(500),
      })
    );
    const response = makeResponse({ count: 5, results });
    const { text } = renderSearchMessage(response);
    // Signal limit is ~50k but in practice much shorter; just check it's reasonable
    expect(text.length).toBeLessThan(10_000);
  });
});

describe('renderSearchCompact', () => {
  it('returns compact string for no results', () => {
    const response = makeResponse({ query: 'foo', count: 0, results: [] });
    const text = renderSearchCompact(response);
    expect(text).toContain('no results');
    expect(text).toContain('foo');
  });

  it('returns compact string with count and top score', () => {
    const result = makeResult({ llmScore: 5 });
    const response = makeResponse({ query: 'bar', count: 1, results: [result] });
    const text = renderSearchCompact(response);
    expect(text).toContain('1 result');
    expect(text).toContain('5/5');
    expect(text).toContain('bar');
  });

  it('omits score when top result has no llm score', () => {
    const result = makeResult({ llmScore: null });
    const response = makeResponse({ query: 'baz', count: 1, results: [result] });
    const text = renderSearchCompact(response);
    expect(text).not.toContain('/5');
  });
});
