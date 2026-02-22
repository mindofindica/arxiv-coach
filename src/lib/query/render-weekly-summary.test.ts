import { describe, expect, it } from 'vitest';
import { renderWeeklySummaryMessage, renderWeeklySummaryCompact } from './render-weekly-summary.js';
import type { WeeklySummary } from './weekly-summary.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function emptySummary(overrides: Partial<WeeklySummary> = {}): WeeklySummary {
  return {
    kind: 'weeklySummary',
    weekIso: '2026-W08',
    dateRange: { start: '2026-02-16', end: '2026-02-22' },
    totalPapers: 0,
    trackStats: [],
    topPapers: [],
    deepDive: { sent: false, arxivId: null, title: null },
    ...overrides,
  };
}

function paperFixture(
  arxivId: string,
  title: string,
  llmScore: number | null,
  keywordScore: number,
  tracks: string[] = ['Track A'],
  absUrl: string | null = null
): WeeklySummary['topPapers'][number] {
  return { arxivId, title, llmScore, keywordScore, tracks, absUrl };
}

function trackFixture(
  trackName: string,
  count: number,
  topKeywordScore: number,
  topLlmScore: number | null = null
): WeeklySummary['trackStats'][number] {
  return { trackName, count, topKeywordScore, topLlmScore };
}

// ─── renderWeeklySummaryMessage ───────────────────────────────────────────────

describe('renderWeeklySummaryMessage — empty week', () => {
  it('includes week header', () => {
    const { text } = renderWeeklySummaryMessage(emptySummary());
    expect(text).toContain('2026-W08');
  });

  it('includes date range', () => {
    const { text } = renderWeeklySummaryMessage(emptySummary());
    expect(text).toContain('2026-02-16');
    expect(text).toContain('2026-02-22');
  });

  it('shows "no papers matched" message', () => {
    const { text } = renderWeeklySummaryMessage(emptySummary());
    expect(text).toContain('No papers matched');
  });

  it('truncated is false for empty summary (short message)', () => {
    const { truncated } = renderWeeklySummaryMessage(emptySummary());
    expect(truncated).toBe(false);
  });
});

describe('renderWeeklySummaryMessage — with papers', () => {
  it('shows total paper count', () => {
    const summary = emptySummary({
      totalPapers: 7,
      trackStats: [trackFixture('Track A', 7, 5)],
      topPapers: [paperFixture('2602.01', 'Test Paper', null, 5)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('7 papers matched');
  });

  it('uses singular "paper" for 1 result', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Single Paper', null, 5)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toMatch(/1 paper matched/);
  });

  it('shows track names and counts', () => {
    const summary = emptySummary({
      totalPapers: 5,
      trackStats: [
        trackFixture('LLMs', 3, 8),
        trackFixture('RLHF', 2, 5),
      ],
      topPapers: [],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('LLMs');
    expect(text).toContain('3 papers');
    expect(text).toContain('RLHF');
    expect(text).toContain('2 papers');
  });

  it('shows track LLM score when available', () => {
    const summary = emptySummary({
      totalPapers: 2,
      trackStats: [trackFixture('AI Safety', 2, 6, 5)],
      topPapers: [],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('best LLM: 5/5');
  });

  it('does not show LLM label for track when score is null', () => {
    const summary = emptySummary({
      totalPapers: 2,
      trackStats: [trackFixture('Track A', 2, 6, null)],
      topPapers: [],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).not.toContain('best LLM');
  });
});

describe('renderWeeklySummaryMessage — top papers', () => {
  it('includes paper titles', () => {
    const summary = emptySummary({
      totalPapers: 2,
      trackStats: [trackFixture('Track A', 2, 5)],
      topPapers: [
        paperFixture('2602.01', 'Awesome LLM Paper', 5, 3),
        paperFixture('2602.02', 'Another Paper', null, 8),
      ],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('Awesome LLM Paper');
    expect(text).toContain('Another Paper');
  });

  it('shows LLM score for papers with LLM scores', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 3)],
      topPapers: [paperFixture('2602.01', 'Test', 4, 3)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('LLM:4/5');
  });

  it('shows fire emoji for LLM score 5', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Must Read', 5, 5)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('🔥');
  });

  it('shows star emoji for LLM score 4', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 4)],
      topPapers: [paperFixture('2602.01', 'Good Paper', 4, 4)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('⭐');
  });

  it('shows keyword score for papers without LLM score', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 7)],
      topPapers: [paperFixture('2602.01', 'Keyword Paper', null, 7)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('kw:7');
  });

  it('shows "LLM-ranked" header when LLM scores exist', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 3)],
      topPapers: [paperFixture('2602.01', 'Paper', 4, 3)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('LLM-ranked');
  });

  it('shows "keyword score" header when no LLM scores', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Paper', null, 5)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('keyword score');
  });

  it('includes absUrl when present', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Paper', 5, 5, ['Track A'], 'https://arxiv.org/abs/2602.01')],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('https://arxiv.org/abs/2602.01');
  });

  it('does not show url line when absUrl is null', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('Track A', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Paper Without URL', 5, 5, ['Track A'], null)],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).not.toContain('https://');
  });

  it('shows track names in paper listing', () => {
    const summary = emptySummary({
      totalPapers: 1,
      trackStats: [trackFixture('LLMs', 1, 5)],
      topPapers: [paperFixture('2602.01', 'Paper', 4, 5, ['LLMs', 'RLHF'])],
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('LLMs');
    expect(text).toContain('RLHF');
  });
});

describe('renderWeeklySummaryMessage — deep dive', () => {
  it('shows "not yet sent" when deep dive pending', () => {
    const summary = emptySummary({
      totalPapers: 3,
      trackStats: [trackFixture('Track A', 3, 5)],
      topPapers: [paperFixture('2602.01', 'Paper', 5, 5)],
      deepDive: { sent: false, arxivId: null, title: null },
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('not yet sent');
  });

  it('shows "sent" and deep dive title when sent', () => {
    const summary = emptySummary({
      totalPapers: 3,
      trackStats: [trackFixture('Track A', 3, 5)],
      topPapers: [paperFixture('2602.01', 'Paper', 5, 5)],
      deepDive: {
        sent: true,
        arxivId: '2602.01',
        title: 'The Amazing Deep Dive Paper',
      },
    });
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('sent');
    expect(text).toContain('The Amazing Deep Dive Paper');
  });
});

// ─── renderWeeklySummaryCompact ───────────────────────────────────────────────

describe('renderWeeklySummaryCompact', () => {
  it('returns "no papers matched" for empty week', () => {
    const result = renderWeeklySummaryCompact(emptySummary());
    expect(result).toContain('no papers matched');
    expect(result).toContain('2026-W08');
  });

  it('includes paper count and track count', () => {
    const summary = emptySummary({
      totalPapers: 12,
      trackStats: [
        trackFixture('LLMs', 8, 5),
        trackFixture('RLHF', 4, 3),
      ],
      topPapers: [],
    });
    const result = renderWeeklySummaryCompact(summary);
    expect(result).toContain('12 papers');
    expect(result).toContain('2 tracks');
  });

  it('uses singular "track" for 1 track', () => {
    const summary = emptySummary({
      totalPapers: 5,
      trackStats: [trackFixture('LLMs', 5, 5)],
      topPapers: [],
    });
    const result = renderWeeklySummaryCompact(summary);
    // "1 track" without an "s" — check it says "track" not "tracks"
    expect(result).toContain('1 track');
    expect(result).not.toContain('1 tracks');
  });

  it('appends "deep dive sent" when deep dive was sent', () => {
    const summary = emptySummary({
      totalPapers: 5,
      trackStats: [trackFixture('Track A', 5, 5)],
      topPapers: [],
      deepDive: { sent: true, arxivId: '2602.01', title: 'Test' },
    });
    const result = renderWeeklySummaryCompact(summary);
    expect(result).toContain('deep dive sent');
  });

  it('does not mention deep dive when not sent', () => {
    const summary = emptySummary({
      totalPapers: 5,
      trackStats: [trackFixture('Track A', 5, 5)],
      topPapers: [],
    });
    const result = renderWeeklySummaryCompact(summary);
    expect(result).not.toContain('deep dive');
  });
});
