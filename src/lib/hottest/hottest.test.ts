/**
 * Tests for the /hottest command — top-scoring papers query & formatting.
 *
 * Uses in-memory SQLite databases to verify:
 *   - queryHottestPapers: dedup/non-dedup, window, minScore, track filter
 *   - formatWindowLabel: human-readable window strings
 *   - formatHottestPaperItem: per-paper formatting, score icons, term truncation
 *   - formatHottestReply: full message assembly, empty state, truncation note
 *   - getHottestPapers: end-to-end integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../db.js';
import {
  queryHottestPapers,
  countHottestPapers,
  formatWindowLabel,
  formatHottestPaperItem,
  formatHottestReply,
  getHottestPapers,
  type HottestPaper,
  type HottestResult,
} from './hottest.js';

// ── Test DB helpers ────────────────────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite };
}

function bootstrapSchema(db: Db): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      arxiv_id TEXT PRIMARY KEY,
      latest_version TEXT,
      title TEXT NOT NULL,
      abstract TEXT NOT NULL,
      authors_json TEXT NOT NULL DEFAULT '[]',
      categories_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pdf_path TEXT NOT NULL DEFAULT '',
      txt_path TEXT NOT NULL DEFAULT '',
      meta_path TEXT NOT NULL DEFAULT '',
      sha256_pdf TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS track_matches (
      arxiv_id TEXT NOT NULL,
      track_name TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      matched_terms_json TEXT NOT NULL DEFAULT '[]',
      matched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (arxiv_id, track_name)
    );
  `);
}

/**
 * Insert a paper and a track match with an explicit matched_at date.
 */
function insertPaper(
  db: Db,
  arxivId: string,
  title: string,
  authors: string[],
  publishedAt: string
): void {
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO papers
       (arxiv_id, latest_version, title, abstract, authors_json, categories_json, published_at, updated_at)
       VALUES (?, 'v1', ?, 'Abstract text.', ?, '[]', ?, ?)`
    )
    .run(arxivId, title, JSON.stringify(authors), publishedAt, publishedAt);
}

function insertMatch(
  db: Db,
  arxivId: string,
  trackName: string,
  score: number,
  matchedAt: string,
  terms: string[] = ['term1', 'term2']
): void {
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO track_matches
       (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(arxivId, trackName, score, JSON.stringify(terms), matchedAt);
}

/** Return an ISO timestamp N days in the past from now */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ── formatWindowLabel ─────────────────────────────────────────────────────────

describe('formatWindowLabel', () => {
  it('renders 1 day as "last 24 hours"', () => {
    expect(formatWindowLabel(1)).toBe('last 24 hours');
  });

  it('renders 7 days as "last 7 days"', () => {
    expect(formatWindowLabel(7)).toBe('last 7 days');
  });

  it('renders 14 days as "last 2 weeks"', () => {
    expect(formatWindowLabel(14)).toBe('last 2 weeks');
  });

  it('renders 30 days as "last 30 days"', () => {
    expect(formatWindowLabel(30)).toBe('last 30 days');
  });

  it('renders arbitrary days as "last N days"', () => {
    expect(formatWindowLabel(10)).toBe('last 10 days');
    expect(formatWindowLabel(60)).toBe('last 60 days');
  });
});

// ── queryHottestPapers ────────────────────────────────────────────────────────

describe('queryHottestPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    bootstrapSchema(db);
  });

  it('returns empty array when no papers in DB', () => {
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results).toEqual([]);
  });

  it('returns papers within the window', () => {
    insertPaper(db, '2603.00001', 'Paper One', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 9, daysAgo(2));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00001');
    expect(results[0]!.score).toBe(9);
  });

  it('excludes papers outside the window', () => {
    insertPaper(db, '2603.00001', 'Old Paper', ['Alice'], '2026-03-01T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 9, daysAgo(10));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results).toEqual([]);
  });

  it('orders papers by score DESC', () => {
    insertPaper(db, '2603.00001', 'Paper One', ['Alice'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'Paper Two', ['Bob'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00003', 'Paper Three', ['Carol'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track A', 5, daysAgo(1));
    insertMatch(db, '2603.00002', 'Track B', 11, daysAgo(1));
    insertMatch(db, '2603.00003', 'Track C', 8, daysAgo(1));

    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results.map((r) => r.score)).toEqual([11, 8, 5]);
  });

  it('respects the limit option', () => {
    for (let i = 1; i <= 10; i++) {
      const id = `2603.0000${i}`;
      insertPaper(db, id, `Paper ${i}`, ['Alice'], '2026-03-10T00:00:00Z');
      insertMatch(db, id, 'Track', i, daysAgo(1));
    }
    const results = queryHottestPapers(db, { windowDays: 7, limit: 3 });
    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBe(10); // top score
  });

  it('caps limit at 20', () => {
    for (let i = 1; i <= 25; i++) {
      const id = `2603.${String(i).padStart(5, '0')}`;
      insertPaper(db, id, `Paper ${i}`, ['Alice'], '2026-03-10T00:00:00Z');
      insertMatch(db, id, 'Track', i, daysAgo(1));
    }
    const results = queryHottestPapers(db, { windowDays: 7, limit: 25 });
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('respects minScore option', () => {
    insertPaper(db, '2603.00001', 'High Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'Low Paper', ['Bob'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 10, daysAgo(1));
    insertMatch(db, '2603.00002', 'Track', 3, daysAgo(1));

    const results = queryHottestPapers(db, { windowDays: 7, minScore: 8 });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00001');
  });

  it('dedup=true shows each paper once (best track)', () => {
    // Same paper in 2 tracks
    insertPaper(db, '2603.00001', 'Cross-track Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 11, daysAgo(1));
    insertMatch(db, '2603.00001', 'AI Safety', 9, daysAgo(1));

    const results = queryHottestPapers(db, { windowDays: 7, dedup: true });
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(11); // best score wins
  });

  it('dedup=false shows paper once per track', () => {
    insertPaper(db, '2603.00001', 'Cross-track Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 11, daysAgo(1));
    insertMatch(db, '2603.00001', 'AI Safety', 9, daysAgo(1));

    const results = queryHottestPapers(db, { windowDays: 7, dedup: false });
    expect(results).toHaveLength(2);
    const scores = results.map((r) => r.score).sort((a, b) => b - a);
    expect(scores).toEqual([11, 9]);
  });

  it('filters by track name (case-insensitive)', () => {
    insertPaper(db, '2603.00001', 'Agent Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'Safety Paper', ['Bob'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 9, daysAgo(1));
    insertMatch(db, '2603.00002', 'AI Safety', 8, daysAgo(1));

    const results = queryHottestPapers(db, { windowDays: 7, track: 'safety' });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00002');
  });

  it('maps authors_json to formatted string', () => {
    insertPaper(db, '2603.00001', 'Paper', ['Alice', 'Bob', 'Carol', 'Dave'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(1));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.authors).toBe('Alice et al.');
  });

  it('handles single author', () => {
    insertPaper(db, '2603.00001', 'Paper', ['Solo Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(1));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.authors).toBe('Solo Author');
  });

  it('handles two authors (no et al.)', () => {
    insertPaper(db, '2603.00001', 'Paper', ['Alice', 'Bob'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(1));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.authors).toBe('Alice, Bob');
  });

  it('handles malformed authors_json gracefully', () => {
    db.sqlite
      .prepare(
        `INSERT OR REPLACE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json, published_at, updated_at)
         VALUES (?, 'v1', 'Paper', 'Abstract', 'not json', '[]', '2026-03-10', '2026-03-10')`
      )
      .run('2603.99999');
    insertMatch(db, '2603.99999', 'Track', 5, daysAgo(1));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.authors).toBe('not json');
  });

  it('includes matchedTerms from JSON', () => {
    insertPaper(db, '2603.00001', 'Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(1), ['planning', 'tool use', 'agents']);
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.matchedTerms).toEqual(['planning', 'tool use', 'agents']);
  });

  it('constructs correct absUrl', () => {
    insertPaper(db, '2603.12345', 'Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.12345', 'Track', 5, daysAgo(1));
    const results = queryHottestPapers(db, { windowDays: 7 });
    expect(results[0]!.absUrl).toBe('https://arxiv.org/abs/2603.12345');
  });
});

// ── formatHottestPaperItem ────────────────────────────────────────────────────

describe('formatHottestPaperItem', () => {
  const basePaper: HottestPaper = {
    arxivId: '2603.12345',
    trackName: 'LLM Agent Architecture',
    score: 11,
    title: 'Self-Calibrating Multi-Agent Systems',
    authors: 'Zhang et al.',
    publishedAt: '2026-03-14T00:00:00Z',
    absUrl: 'https://arxiv.org/abs/2603.12345',
    matchedTerms: ['planning', 'tool use', 'calibration', 'multi-agent', 'reasoning'],
    matchedAt: '2026-03-14T10:00:00Z',
  };

  it('uses 🌟 for score >= 10', () => {
    const text = formatHottestPaperItem({ ...basePaper, score: 11 }, 0);
    expect(text).toContain('🌟');
  });

  it('uses ⭐ for score >= 8 and < 10', () => {
    const text = formatHottestPaperItem({ ...basePaper, score: 9 }, 0);
    expect(text).toContain('⭐');
    expect(text).not.toContain('🌟');
  });

  it('uses ✨ for score < 8', () => {
    const text = formatHottestPaperItem({ ...basePaper, score: 5 }, 0);
    expect(text).toContain('✨');
  });

  it('formats 1-indexed position number', () => {
    const first = formatHottestPaperItem(basePaper, 0);
    const third = formatHottestPaperItem(basePaper, 2);
    expect(first).toMatch(/^1\./);
    expect(third).toMatch(/^3\./);
  });

  it('includes track name after score', () => {
    const text = formatHottestPaperItem(basePaper, 0);
    expect(text).toContain('Score 11 · LLM Agent Architecture');
  });

  it('includes paper title in bold', () => {
    const text = formatHottestPaperItem(basePaper, 0);
    expect(text).toContain('*Self-Calibrating Multi-Agent Systems*');
  });

  it('includes authors and date', () => {
    const text = formatHottestPaperItem(basePaper, 0);
    expect(text).toContain('Zhang et al. · 2026-03-14');
  });

  it('shows up to 5 matched terms', () => {
    const manyTerms = { ...basePaper, matchedTerms: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'] };
    const text = formatHottestPaperItem(manyTerms, 0);
    expect(text).toContain('Matched: alpha, beta, gamma, delta, epsilon');
    expect(text).not.toContain('zeta');
  });

  it('skips matched terms line when empty', () => {
    const noTerms = { ...basePaper, matchedTerms: [] };
    const text = formatHottestPaperItem(noTerms, 0);
    expect(text).not.toContain('Matched:');
  });

  it('includes arxiv URL', () => {
    const text = formatHottestPaperItem(basePaper, 0);
    expect(text).toContain('https://arxiv.org/abs/2603.12345');
  });
});

// ── formatHottestReply ────────────────────────────────────────────────────────

describe('formatHottestReply', () => {
  const makePaper = (n: number, score: number, track: string): HottestPaper => ({
    arxivId: `2603.0000${n}`,
    trackName: track,
    score,
    title: `Test Paper ${n}`,
    authors: 'Alice et al.',
    publishedAt: '2026-03-14T00:00:00Z',
    absUrl: `https://arxiv.org/abs/2603.0000${n}`,
    matchedTerms: ['term1'],
    matchedAt: '2026-03-14T10:00:00Z',
  });

  const makeResult = (papers: HottestPaper[], opts?: Partial<HottestResult>): HottestResult => ({
    papers,
    totalFound: papers.length,
    windowDays: 7,
    limit: 5,
    dedup: true,
    trackFilter: null,
    ...opts,
  });

  it('shows empty state when no papers', () => {
    const reply = formatHottestReply(makeResult([]));
    expect(reply).toContain('No papers found');
    expect(reply).toContain('last 7 days');
  });

  it('empty state includes hint to widen window', () => {
    const reply = formatHottestReply(makeResult([]));
    expect(reply).toContain('--days 14');
  });

  it('empty state with track filter includes track name', () => {
    const reply = formatHottestReply(makeResult([], { trackFilter: 'AI Safety' }));
    expect(reply).toContain('*AI Safety*');
  });

  it('includes header with count and window', () => {
    const papers = [makePaper(1, 10, 'LLM Agents')];
    const reply = formatHottestReply(makeResult(papers));
    expect(reply).toContain('Top 1 papers');
    expect(reply).toContain('last 7 days');
  });

  it('header includes truncation note when totalFound > papers.length', () => {
    const papers = [makePaper(1, 10, 'LLM Agents')];
    const reply = formatHottestReply(makeResult(papers, { totalFound: 20 }));
    expect(reply).toContain('showing 1 of 20');
  });

  it('no truncation note when all results shown', () => {
    const papers = [makePaper(1, 10, 'LLM Agents')];
    const reply = formatHottestReply(makeResult(papers, { totalFound: 1 }));
    expect(reply).not.toContain('showing');
  });

  it('header includes track filter', () => {
    const papers = [makePaper(1, 10, 'AI Safety')];
    const reply = formatHottestReply(makeResult(papers, { trackFilter: 'AI Safety' }));
    expect(reply).toContain('AI Safety');
  });

  it('renders multiple papers in order', () => {
    const papers = [
      makePaper(1, 11, 'LLM Agents'),
      makePaper(2, 9, 'AI Safety'),
      makePaper(3, 7, 'Efficiency'),
    ];
    const reply = formatHottestReply(makeResult(papers));
    // Use line-start anchors to avoid false matches inside URLs or scores
    const pos1 = reply.indexOf('\n1.');
    const pos2 = reply.indexOf('\n2.');
    const pos3 = reply.indexOf('\n3.');
    expect(pos1).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos3);
  });

  it('separates papers with blank lines', () => {
    const papers = [makePaper(1, 11, 'LLM Agents'), makePaper(2, 9, 'AI Safety')];
    const reply = formatHottestReply(makeResult(papers));
    expect(reply).toContain('\n\n');
  });

  it('uses 1-day window label correctly', () => {
    const reply = formatHottestReply(makeResult([], { windowDays: 1 }));
    expect(reply).toContain('last 24 hours');
  });
});

// ── getHottestPapers (integration) ───────────────────────────────────────────

describe('getHottestPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    bootstrapSchema(db);
  });

  it('returns papers and reply', () => {
    insertPaper(db, '2603.00001', 'Top Paper', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'LLM Agents', 11, daysAgo(2), ['agents', 'planning']);

    const result = getHottestPapers(db);
    expect(result.papers).toHaveLength(1);
    expect(result.reply).toContain('Top Paper');
    expect(result.reply).toContain('Score 11');
    expect(result.reply).toContain('LLM Agents');
  });

  it('returns empty reply when DB is empty', () => {
    const result = getHottestPapers(db);
    expect(result.papers).toHaveLength(0);
    expect(result.reply).toContain('No papers found');
  });

  it('uses defaults (7 days, 5 papers, dedup=true)', () => {
    for (let i = 1; i <= 8; i++) {
      const id = `2603.0000${i}`;
      insertPaper(db, id, `Paper ${i}`, ['Alice'], '2026-03-10T00:00:00Z');
      insertMatch(db, id, 'Track', i, daysAgo(3));
    }
    const result = getHottestPapers(db);
    expect(result.papers).toHaveLength(5);
    expect(result.windowDays).toBe(7);
    expect(result.dedup).toBe(true);
  });

  it('respects custom options', () => {
    insertPaper(db, '2603.00001', 'Recent', ['Alice'], '2026-03-14T00:00:00Z');
    insertPaper(db, '2603.00002', 'Old', ['Bob'], '2026-02-01T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 7, daysAgo(2));
    insertMatch(db, '2603.00002', 'Track', 9, daysAgo(20));

    const result = getHottestPapers(db, { windowDays: 7, limit: 2 });
    // Only '2603.00001' is within the 7-day window
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]!.arxivId).toBe('2603.00001');
  });

  it('totalFound reflects actual result count when all fit within limit', () => {
    insertPaper(db, '2603.00001', 'Paper 1', ['Alice'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(2));
    const result = getHottestPapers(db);
    expect(result.totalFound).toBe(result.papers.length);
    expect(result.totalFound).toBe(1);
  });

  it('totalFound reflects full pool when papers exceed the limit', () => {
    // Seed 10 papers, but request only 3
    for (let i = 1; i <= 10; i++) {
      insertPaper(db, `2603.0000${i}`, `Paper ${i}`, ['Author'], '2026-03-10T00:00:00Z');
      insertMatch(db, `2603.0000${i}`, 'Track', i + 3, daysAgo(1));
    }

    const result = getHottestPapers(db, { windowDays: 7, limit: 3 });
    // Should return 3 papers but totalFound should be 10
    expect(result.papers).toHaveLength(3);
    expect(result.totalFound).toBe(10);
    // The formatted reply should show the truncation note
    expect(result.reply).toContain('showing 3 of 10');
  });
});

// ── countHottestPapers ────────────────────────────────────────────────────────

describe('countHottestPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    bootstrapSchema(db);
  });

  it('returns 0 when no papers match', () => {
    expect(countHottestPapers(db)).toBe(0);
  });

  it('counts unique papers with dedup=true', () => {
    // One paper matching two tracks should count as 1
    insertPaper(db, '2603.00001', 'Paper', ['Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track A', 9, daysAgo(1));
    insertMatch(db, '2603.00001', 'Track B', 7, daysAgo(1));

    expect(countHottestPapers(db, { dedup: true })).toBe(1);
  });

  it('counts per-(arxiv_id, track) rows with dedup=false', () => {
    // One paper matching two tracks should count as 2
    insertPaper(db, '2603.00001', 'Paper', ['Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track A', 9, daysAgo(1));
    insertMatch(db, '2603.00001', 'Track B', 7, daysAgo(1));

    expect(countHottestPapers(db, { dedup: false })).toBe(2);
  });

  it('respects the minScore filter', () => {
    insertPaper(db, '2603.00001', 'Low scorer', ['Author'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'High scorer', ['Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 5, daysAgo(1));
    insertMatch(db, '2603.00002', 'Track', 9, daysAgo(1));

    expect(countHottestPapers(db, { minScore: 8 })).toBe(1);
    expect(countHottestPapers(db, { minScore: 1 })).toBe(2);
  });

  it('respects the windowDays filter', () => {
    insertPaper(db, '2603.00001', 'Recent', ['Author'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'Old', ['Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'Track', 8, daysAgo(2));
    insertMatch(db, '2603.00002', 'Track', 8, daysAgo(15));

    expect(countHottestPapers(db, { windowDays: 7 })).toBe(1);
    expect(countHottestPapers(db, { windowDays: 30 })).toBe(2);
  });

  it('respects the track filter', () => {
    insertPaper(db, '2603.00001', 'Paper A', ['Author'], '2026-03-10T00:00:00Z');
    insertPaper(db, '2603.00002', 'Paper B', ['Author'], '2026-03-10T00:00:00Z');
    insertMatch(db, '2603.00001', 'RAG', 8, daysAgo(1));
    insertMatch(db, '2603.00002', 'Multi-Agent', 8, daysAgo(1));

    expect(countHottestPapers(db, { track: 'rag' })).toBe(1);
    expect(countHottestPapers(db, { track: 'agent' })).toBe(1);
    expect(countHottestPapers(db, { track: null })).toBe(2);
  });
});
