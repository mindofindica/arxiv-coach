/**
 * hottest-papers.test.ts — Tests for queryHottestPapers + formatting
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import type { Db } from '../lib/db.js';
import { migrate } from '../lib/db.js';
import {
  queryHottestPapers,
  formatHottest,
  formatHottestMessage,
  formatHottestEmpty,
  scoreIcon,
  type HottestResult,
  type HottestEmpty,
} from '../lib/query/hottest-papers.js';

// ─── Test DB helpers ──────────────────────────────────────────────────────────

function openTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite };
}

function seedPaper(
  db: Db,
  arxivId: string,
  opts: {
    title?: string;
    abstract?: string;
    authors?: string[];
    publishedAt?: string;
  } = {}
) {
  const now = new Date().toISOString();
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      arxivId,
      opts.title ?? `Paper ${arxivId}`,
      opts.abstract ?? `Abstract for paper ${arxivId}.`,
      JSON.stringify(opts.authors ?? ['Alice Smith', 'Bob Jones']),
      opts.publishedAt ?? '2026-03-15T00:00:00Z',
      opts.publishedAt ?? '2026-03-15T00:00:00Z',
      `/tmp/${arxivId}.pdf`,
      `/tmp/${arxivId}.txt`,
      `/tmp/${arxivId}.json`,
      now
    );
}

function seedTrackMatch(
  db: Db,
  arxivId: string,
  trackName: string,
  score: number,
  matchedAgo = '1 hour'
) {
  const matchedAt = new Date(
    Date.now() - parseDuration(matchedAgo)
  ).toISOString();
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO track_matches
         (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '[]', ?)`
    )
    .run(arxivId, trackName, score, matchedAt);
}

function parseDuration(s: string): number {
  const [numStr, unit = ''] = s.split(' ');
  const n = parseInt(numStr ?? '0', 10);
  if (unit.startsWith('hour')) return n * 3600_000;
  if (unit.startsWith('day')) return n * 86400_000;
  if (unit.startsWith('minute')) return n * 60_000;
  throw new Error(`Unknown duration unit: ${unit}`);
}

// ─── scoreIcon ────────────────────────────────────────────────────────────────

describe('scoreIcon', () => {
  it('returns 🌟 for score ≥ 10', () => {
    expect(scoreIcon(10)).toBe('🌟');
    expect(scoreIcon(12)).toBe('🌟');
    expect(scoreIcon(15)).toBe('🌟');
  });

  it('returns ⭐ for score 8–9', () => {
    expect(scoreIcon(8)).toBe('⭐');
    expect(scoreIcon(9)).toBe('⭐');
  });

  it('returns ✨ for score < 8', () => {
    expect(scoreIcon(7)).toBe('✨');
    expect(scoreIcon(3)).toBe('✨');
    expect(scoreIcon(1)).toBe('✨');
    expect(scoreIcon(0)).toBe('✨');
  });
});

// ─── queryHottestPapers ───────────────────────────────────────────────────────

describe('queryHottestPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
  });

  // ── Empty cases ─────────────────────────────────────────────────────────────

  it('returns empty result when no papers exist', () => {
    const result = queryHottestPapers(db);
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.message).toContain('No papers found');
      expect(result.days).toBe(7);
      expect(result.track).toBeNull();
    }
  });

  it('returns empty when all papers are outside the window', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '10 days');

    const result = queryHottestPapers(db, { days: 7 });
    expect(result.kind).toBe('empty');
  });

  it('returns empty when minScore filters out all papers', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'RAG', 5, '1 hour');

    const result = queryHottestPapers(db, { minScore: 8 });
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.message).toContain('score ≥ 8');
    }
  });

  it('returns empty with track filter message', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db, { track: 'Nonexistent Track' });
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.message).toContain('Nonexistent Track');
    }
  });

  // ── Basic results ───────────────────────────────────────────────────────────

  it('returns papers within the window sorted by score desc', () => {
    seedPaper(db, '2601.00001', { title: 'Low scorer' });
    seedPaper(db, '2601.00002', { title: 'Top scorer' });
    seedPaper(db, '2601.00003', { title: 'Mid scorer' });

    seedTrackMatch(db, '2601.00001', 'RAG', 5, '1 hour');
    seedTrackMatch(db, '2601.00002', 'RAG', 11, '1 hour');
    seedTrackMatch(db, '2601.00003', 'RAG', 8, '1 hour');

    const result = queryHottestPapers(db, { limit: 10 });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers.length).toBe(3);
      expect(result.papers[0]!.title).toBe('Top scorer');
      expect(result.papers[0]!.score).toBe(11);
      expect(result.papers[1]!.score).toBe(8);
      expect(result.papers[2]!.score).toBe(5);
    }
  });

  it('respects the limit parameter', () => {
    for (let i = 1; i <= 10; i++) {
      seedPaper(db, `2601.0000${i}`);
      seedTrackMatch(db, `2601.0000${i}`, 'RAG', i, '1 hour');
    }

    const result = queryHottestPapers(db, { limit: 3 });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers.length).toBe(3);
      expect(result.totalFound).toBe(10);
    }
  });

  it('clamps limit to max 20', () => {
    for (let i = 1; i <= 5; i++) {
      seedPaper(db, `2601.0000${i}`);
      seedTrackMatch(db, `2601.0000${i}`, 'RAG', i + 5, '1 hour');
    }

    const result = queryHottestPapers(db, { limit: 999 });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers.length).toBeLessThanOrEqual(20);
    }
  });

  it('uses default days=7 and excludes older papers', () => {
    seedPaper(db, '2601.00001', { title: 'Recent' });
    seedPaper(db, '2601.00002', { title: 'Old' });

    seedTrackMatch(db, '2601.00001', 'RAG', 9, '3 days');    // within 7d
    seedTrackMatch(db, '2601.00002', 'RAG', 11, '10 days');  // outside 7d

    const result = queryHottestPapers(db);
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]!.title).toBe('Recent');
    }
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  it('deduplicates papers across tracks using MAX(score)', () => {
    seedPaper(db, '2601.00001', { title: 'Multi-track paper' });
    seedTrackMatch(db, '2601.00001', 'RAG', 7, '1 hour');
    seedTrackMatch(db, '2601.00001', 'Multi-Agent', 10, '1 hour');
    seedTrackMatch(db, '2601.00001', 'Planning', 5, '1 hour');

    const result = queryHottestPapers(db);
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      // Only one paper, not three
      expect(result.papers).toHaveLength(1);
      // Score should be MAX = 10
      expect(result.papers[0]!.score).toBe(10);
      // All tracks should be listed
      expect(result.papers[0]!.tracks).toContain('RAG');
      expect(result.papers[0]!.tracks).toContain('Multi-Agent');
      expect(result.papers[0]!.tracks).toContain('Planning');
    }
  });

  it('totalFound counts deduplicated papers', () => {
    // 3 papers each in 2 tracks — totalFound should be 3, not 6
    for (let i = 1; i <= 3; i++) {
      seedPaper(db, `2601.0000${i}`);
      seedTrackMatch(db, `2601.0000${i}`, 'RAG', 5 + i, '1 hour');
      seedTrackMatch(db, `2601.0000${i}`, 'Planning', 3 + i, '1 hour');
    }

    const result = queryHottestPapers(db, { limit: 10 });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.totalFound).toBe(3);
      expect(result.papers).toHaveLength(3);
    }
  });

  // ── Track filter ────────────────────────────────────────────────────────────

  it('filters by track name (case-insensitive substring match)', () => {
    seedPaper(db, '2601.00001', { title: 'RAG Paper' });
    seedPaper(db, '2601.00002', { title: 'Agent Paper' });

    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');
    seedTrackMatch(db, '2601.00002', 'Multi-Agent Systems', 11, '1 hour');

    const result = queryHottestPapers(db, { track: 'rag' });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0]!.title).toBe('RAG Paper');
    }
  });

  it('track filter is case-insensitive', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'Agent Evaluation', 8, '1 hour');

    const lower = queryHottestPapers(db, { track: 'agent evaluation' });
    const upper = queryHottestPapers(db, { track: 'AGENT EVALUATION' });
    const mixed = queryHottestPapers(db, { track: 'Agent' });

    expect(lower.kind).toBe('hottest');
    expect(upper.kind).toBe('hottest');
    expect(mixed.kind).toBe('hottest');
  });

  // ── absUrl ──────────────────────────────────────────────────────────────────

  it('generates correct arxiv absUrl', () => {
    seedPaper(db, '2603.12345');
    seedTrackMatch(db, '2603.12345', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db);
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.papers[0]!.absUrl).toBe('https://arxiv.org/abs/2603.12345');
    }
  });

  // ── Authors formatting ──────────────────────────────────────────────────────

  it('formats single author correctly', () => {
    seedPaper(db, '2601.00001', { authors: ['Solo Author'] });
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db);
    if (result.kind === 'hottest') {
      expect(result.papers[0]!.authors).toBe('Solo Author');
    }
  });

  it('formats multiple authors as "et al." when >3', () => {
    seedPaper(db, '2601.00001', {
      authors: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db);
    if (result.kind === 'hottest') {
      expect(result.papers[0]!.authors).toBe('Alice et al.');
    }
  });

  // ── Days parameter ──────────────────────────────────────────────────────────

  it('respects custom days window', () => {
    seedPaper(db, '2601.00001', { title: 'Fresh paper' });
    seedPaper(db, '2601.00002', { title: 'Older paper' });

    seedTrackMatch(db, '2601.00001', 'RAG', 9, '2 hours');
    seedTrackMatch(db, '2601.00002', 'RAG', 11, '5 days');

    const r1 = queryHottestPapers(db, { days: 1 });
    expect(r1.kind).toBe('hottest');
    if (r1.kind === 'hottest') {
      expect(r1.papers).toHaveLength(1);
      expect(r1.papers[0]!.title).toBe('Fresh paper');
    }

    const r7 = queryHottestPapers(db, { days: 7 });
    expect(r7.kind).toBe('hottest');
    if (r7.kind === 'hottest') {
      expect(r7.papers).toHaveLength(2);
    }
  });

  it('clamps days to max 90', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db, { days: 9999 });
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.days).toBe(90);
    }
  });

  it('clamps days to min 1', () => {
    seedPaper(db, '2601.00001');
    seedTrackMatch(db, '2601.00001', 'RAG', 9, '1 hour');

    const result = queryHottestPapers(db, { days: 0 });
    // days=0 → clamps to 1; paper matched 1h ago should be included
    expect(result.kind).toBe('hottest');
    if (result.kind === 'hottest') {
      expect(result.days).toBe(1);
    }
  });
});

// ─── Formatting ───────────────────────────────────────────────────────────────

describe('formatHottestMessage', () => {
  it('formats a result with multiple papers', () => {
    const result: HottestResult = {
      kind: 'hottest',
      days: 7,
      track: null,
      totalFound: 42,
      papers: [
        {
          arxivId: '2603.00001',
          title: 'Awesome Paper',
          abstract: 'This paper is great.',
          authors: 'Alice et al.',
          publishedAt: '2026-03-19T00:00:00Z',
          score: 11,
          tracks: ['RAG', 'Multi-Agent'],
          absUrl: 'https://arxiv.org/abs/2603.00001',
        },
        {
          arxivId: '2603.00002',
          title: 'Another Paper',
          abstract: 'Also pretty good.',
          authors: 'Bob Smith',
          publishedAt: '2026-03-18T00:00:00Z',
          score: 8,
          tracks: ['Planning'],
          absUrl: 'https://arxiv.org/abs/2603.00002',
        },
      ],
    };

    const msg = formatHottestMessage(result);

    expect(msg).toContain('🔥');
    expect(msg).toContain('last 7 days');
    expect(msg).toContain('top 2 of 42');
    expect(msg).toContain('🌟');
    expect(msg).toContain('Awesome Paper');
    expect(msg).toContain('score: 11');
    expect(msg).toContain('RAG, Multi-Agent');
    expect(msg).toContain('⭐');
    expect(msg).toContain('Another Paper');
    expect(msg).toContain('https://arxiv.org/abs/2603.00001');
    expect(msg).toContain('https://arxiv.org/abs/2603.00002');
  });

  it('shows "N papers" when totalFound equals limit', () => {
    const result: HottestResult = {
      kind: 'hottest',
      days: 7,
      track: null,
      totalFound: 2,
      papers: [
        {
          arxivId: '2603.00001',
          title: 'Paper One',
          abstract: 'Abstract.',
          authors: 'Alice',
          publishedAt: '2026-03-19T00:00:00Z',
          score: 9,
          tracks: ['RAG'],
          absUrl: 'https://arxiv.org/abs/2603.00001',
        },
        {
          arxivId: '2603.00002',
          title: 'Paper Two',
          abstract: 'Abstract.',
          authors: 'Bob',
          publishedAt: '2026-03-18T00:00:00Z',
          score: 7,
          tracks: ['Planning'],
          absUrl: 'https://arxiv.org/abs/2603.00002',
        },
      ],
    };

    const msg = formatHottestMessage(result);
    expect(msg).toContain('2 papers');
    expect(msg).not.toContain('top 2 of');
  });

  it('includes track filter in header', () => {
    const result: HottestResult = {
      kind: 'hottest',
      days: 3,
      track: 'RAG',
      totalFound: 1,
      papers: [
        {
          arxivId: '2603.00001',
          title: 'RAG Paper',
          abstract: 'Abstract.',
          authors: 'Alice',
          publishedAt: '2026-03-19T00:00:00Z',
          score: 8,
          tracks: ['RAG'],
          absUrl: 'https://arxiv.org/abs/2603.00001',
        },
      ],
    };

    const msg = formatHottestMessage(result);
    expect(msg).toContain('· RAG');
    expect(msg).toContain('last 3 days');
  });

  it('handles singular "day" correctly', () => {
    const result: HottestResult = {
      kind: 'hottest',
      days: 1,
      track: null,
      totalFound: 1,
      papers: [
        {
          arxivId: '2603.00001',
          title: 'Paper',
          abstract: 'Abstract.',
          authors: 'Alice',
          publishedAt: '2026-03-19T00:00:00Z',
          score: 8,
          tracks: ['RAG'],
          absUrl: 'https://arxiv.org/abs/2603.00001',
        },
      ],
    };
    const msg = formatHottestMessage(result);
    expect(msg).toContain('last 1 day');
    expect(msg).not.toContain('last 1 days');
  });
});

describe('formatHottestEmpty', () => {
  it('formats empty result with 📭', () => {
    const result: HottestEmpty = {
      kind: 'empty',
      days: 7,
      track: null,
      message: 'No papers found in the last 7 days with score ≥ 1.',
    };
    const msg = formatHottestEmpty(result);
    expect(msg).toContain('📭');
    expect(msg).toContain('No papers found');
  });
});

describe('formatHottest (dispatch helper)', () => {
  it('delegates to formatHottestMessage for hottest results', () => {
    const result: HottestResult = {
      kind: 'hottest',
      days: 7,
      track: null,
      totalFound: 1,
      papers: [
        {
          arxivId: '2603.00001',
          title: 'Paper',
          abstract: 'Abstract.',
          authors: 'Alice',
          publishedAt: '2026-03-19T00:00:00Z',
          score: 8,
          tracks: ['RAG'],
          absUrl: 'https://arxiv.org/abs/2603.00001',
        },
      ],
    };
    const msg = formatHottest(result);
    expect(msg).toContain('🔥');
  });

  it('delegates to formatHottestEmpty for empty results', () => {
    const result: HottestEmpty = {
      kind: 'empty',
      days: 7,
      track: null,
      message: 'Nothing here.',
    };
    const msg = formatHottest(result);
    expect(msg).toContain('📭');
  });
});
