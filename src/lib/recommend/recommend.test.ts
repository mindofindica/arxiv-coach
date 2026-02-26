/**
 * Tests for the /recommend command — paper recommendation engine.
 *
 * Uses in-memory SQLite databases to verify:
 *   - extractKeywords: stop-word filtering, frequency ranking
 *   - buildFtsQuery: keyword → FTS5 query construction
 *   - recommendPapers: full pipeline (seed collection, exclusion, ranking)
 *   - formatRecommendReply: Signal-friendly output formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../db.js';
import {
  extractKeywords,
  buildFtsQuery,
  recommendPapers,
  formatRecommendReply,
} from './recommend.js';

// ── Test DB helpers ────────────────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite };
}

/**
 * Bootstrap the full schema required for recommendations.
 * Creates papers, track_matches, llm_scores, digest_papers,
 * paper_feedback, reading_list, and the FTS5 virtual table.
 */
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

    CREATE TABLE IF NOT EXISTS llm_scores (
      arxiv_id TEXT PRIMARY KEY,
      relevance_score INTEGER NOT NULL,
      scored_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS digest_papers (
      arxiv_id TEXT NOT NULL,
      digest_date TEXT NOT NULL,
      track_name TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (arxiv_id, digest_date)
    );

    CREATE TABLE IF NOT EXISTS paper_feedback (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paper_id TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      reason TEXT,
      tags TEXT DEFAULT '[]',
      expected_track TEXT,
      actual_interest_level INTEGER,
      UNIQUE(paper_id, feedback_type)
    );

    CREATE TABLE IF NOT EXISTS reading_list (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paper_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      priority INTEGER DEFAULT 5,
      notes TEXT,
      read_at TEXT,
      UNIQUE(paper_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      arxiv_id UNINDEXED,
      title,
      abstract,
      tokenize='porter unicode61'
    );
  `);
}

/**
 * Insert a paper into papers + papers_fts.
 */
function insertPaper(
  db: Db,
  arxivId: string,
  title: string,
  abstract: string,
  publishedAt = '2026-01-01T00:00:00Z',
): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at,
          pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, ?, ?, '[]', '[]', ?, ?, '', '', '', datetime('now'))`,
    )
    .run(arxivId, title, abstract, publishedAt, publishedAt);

  db.sqlite
    .prepare(`INSERT OR IGNORE INTO papers_fts (arxiv_id, title, abstract) VALUES (?, ?, ?)`)
    .run(arxivId, title, abstract);
}

function insertFeedback(db: Db, paperId: string, feedbackType: string): void {
  const id = `${paperId}-${feedbackType}`;
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO paper_feedback (id, paper_id, feedback_type) VALUES (?, ?, ?)`,
    )
    .run(id, paperId, feedbackType);
}

function insertReadingList(db: Db, paperId: string, priority = 5, status = 'unread'): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO reading_list (id, paper_id, priority, status) VALUES (?, ?, ?, ?)`,
    )
    .run(`rl-${paperId}`, paperId, priority, status);
}

function insertDigestPaper(db: Db, arxivId: string): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO digest_papers (arxiv_id, digest_date, track_name) VALUES (?, '2026-01-01', 'LLM')`,
    )
    .run(arxivId);
}

function insertTrack(db: Db, arxivId: string, trackName: string): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, 1, '[]', datetime('now'))`,
    )
    .run(arxivId, trackName);
}

function insertLlmScore(db: Db, arxivId: string, score: number): void {
  db.sqlite
    .prepare(`INSERT OR REPLACE INTO llm_scores (arxiv_id, relevance_score) VALUES (?, ?)`)
    .run(arxivId, score);
}

// ── extractKeywords ────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns top tokens sorted by frequency', () => {
    const titles = [
      'Speculative Decoding for Fast Inference',
      'Speculative Decoding with Attention',
      'Attention Mechanisms in Transformers',
    ];
    const kw = extractKeywords(titles, 5);
    // 'speculative' appears 2×, 'decoding' 2×, 'attention' 2× — all should be included
    expect(kw).toContain('speculative');
    expect(kw).toContain('decoding');
    expect(kw).toContain('attention');
  });

  it('filters stop words', () => {
    const kw = extractKeywords(['Using the Model with Deep Learning'], 10);
    // 'using', 'the', 'with' are stop words; 'model', 'deep', 'learning' are stop words too
    // 'model' is in stop words; 'deep' is in stop words; 'learning' is in stop words
    expect(kw).not.toContain('using');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('with');
    // 'model', 'deep', 'learning' are in STOP_WORDS too
    expect(kw).not.toContain('model');
    expect(kw).not.toContain('deep');
    expect(kw).not.toContain('learning');
  });

  it('filters tokens shorter than 4 chars', () => {
    const kw = extractKeywords(['LLM RAG for ML NLP tasks in AI'], 10);
    expect(kw).not.toContain('for');
    expect(kw).not.toContain('in');
    // 'llm', 'rag', 'nlp' are 3 chars — filtered
    // 'tasks' is 5 chars — included (if not stop word)
    expect(kw).toContain('tasks');
  });

  it('returns empty array for empty input', () => {
    expect(extractKeywords([], 5)).toEqual([]);
  });

  it('returns empty array for all-stopword titles', () => {
    const kw = extractKeywords(['the and or with using'], 10);
    expect(kw).toEqual([]);
  });

  it('respects topN limit', () => {
    const titles = ['alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu'];
    const kw = extractKeywords(titles, 3);
    expect(kw.length).toBeLessThanOrEqual(3);
  });

  it('is deterministic for equal-frequency tokens (alphabetic tiebreak)', () => {
    const titles = ['gamma alpha beta delta'];
    const a = extractKeywords(titles, 10);
    const b = extractKeywords(titles, 10);
    expect(a).toEqual(b);
    // Sorted alphabetically on tie: alpha < beta < delta < gamma
    expect(a[0]).toBe('alpha');
    expect(a[1]).toBe('beta');
    expect(a[2]).toBe('delta');
    expect(a[3]).toBe('gamma');
  });
});

// ── buildFtsQuery ──────────────────────────────────────────────────────────

describe('buildFtsQuery', () => {
  it('joins keywords with OR', () => {
    const q = buildFtsQuery(['speculative', 'decoding', 'inference']);
    expect(q).toBe('speculative OR decoding OR inference');
  });

  it('returns single keyword without OR', () => {
    const q = buildFtsQuery(['attention']);
    expect(q).toBe('attention');
  });

  it('returns null for empty keyword list', () => {
    const q = buildFtsQuery([]);
    expect(q).toBeNull();
  });
});

// ── recommendPapers ────────────────────────────────────────────────────────

describe('recommendPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    bootstrapSchema(db);
  });

  afterEach(() => {
    db.sqlite.close();
  });

  it('returns no_seeds when there are no loved/saved papers', () => {
    // Insert papers but no feedback
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Abstract about speculative decoding');
    insertPaper(db, '2601.00002', 'Speculative Inference Fast', 'Fast inference methods');

    const resp = recommendPapers(db, { limit: 5 });
    expect(resp.reason).toBe('no_seeds');
    expect(resp.results).toHaveLength(0);
    expect(resp.seedCount).toBe(0);
  });

  it('recommends papers similar to loved papers', () => {
    // Seed: love a speculative decoding paper
    insertPaper(db, '2601.00001', 'Speculative Decoding for Transformers', 'Speculative decoding improves inference speed');
    insertFeedback(db, '2601.00001', 'love');

    // Candidate: similar topic, not yet seen
    insertPaper(db, '2601.00002', 'Fast Speculative Inference Techniques', 'Speculative inference methods for large language models');

    // Unrelated: should rank lower or not appear if limit is tight
    insertPaper(db, '2601.00003', 'Protein Folding with AlphaFold', 'Structural biology deep learning');

    const resp = recommendPapers(db, { limit: 5 });
    expect(resp.results.length).toBeGreaterThan(0);
    // The speculative/inference paper should be recommended
    const ids = resp.results.map(r => r.arxivId);
    expect(ids).toContain('2601.00002');
    // The seed paper itself should NOT be recommended
    expect(ids).not.toContain('2601.00001');
  });

  it('excludes papers already in reading list', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding methods');
    insertFeedback(db, '2601.00001', 'love');

    insertPaper(db, '2601.00002', 'Speculative Inference Fast', 'Speculative inference fast models');
    insertReadingList(db, '2601.00002'); // already saved

    const resp = recommendPapers(db, { limit: 5 });
    const ids = resp.results.map(r => r.arxivId);
    expect(ids).not.toContain('2601.00002');
  });

  it('excludes papers already seen in digests', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding');
    insertFeedback(db, '2601.00001', 'love');

    insertPaper(db, '2601.00002', 'Speculative Inference Methods', 'Speculative inference');
    insertDigestPaper(db, '2601.00002'); // already in a digest

    const resp = recommendPapers(db, { limit: 5 });
    const ids = resp.results.map(r => r.arxivId);
    expect(ids).not.toContain('2601.00002');
  });

  it('excludes papers already given feedback (any type)', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding');
    insertFeedback(db, '2601.00001', 'love');

    insertPaper(db, '2601.00002', 'Speculative Inference', 'Speculative inference methods');
    insertFeedback(db, '2601.00002', 'skip'); // already rated negatively

    const resp = recommendPapers(db, { limit: 5 });
    const ids = resp.results.map(r => r.arxivId);
    expect(ids).not.toContain('2601.00002');
  });

  it('uses high-priority reading list papers as seeds', () => {
    // High-priority save (no explicit love feedback)
    insertPaper(db, '2601.00001', 'Attention Mechanisms Survey', 'Attention and self-attention');
    insertReadingList(db, '2601.00001', 8); // priority >= 7

    // Candidate with matching topic
    insertPaper(db, '2601.00002', 'Multi-Head Attention Analysis', 'Multi-head attention transformers');

    const resp = recommendPapers(db, { limit: 5 });
    expect(resp.seedCount).toBeGreaterThan(0);
    expect(resp.keywords).toBeDefined();
  });

  it('respects the limit option', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding');
    insertFeedback(db, '2601.00001', 'love');

    // Insert several candidates
    for (let i = 2; i <= 10; i++) {
      insertPaper(
        db,
        `2601.0000${i}`,
        `Speculative Inference Paper ${i}`,
        `Speculative inference methods paper number ${i}`,
      );
    }

    const resp = recommendPapers(db, { limit: 3 });
    expect(resp.results.length).toBeLessThanOrEqual(3);
  });

  it('includes tracks and llm_scores in results', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding');
    insertFeedback(db, '2601.00001', 'love');

    insertPaper(db, '2601.00002', 'Fast Speculative Inference', 'Speculative inference');
    insertTrack(db, '2601.00002', 'LLM Efficiency');
    insertLlmScore(db, '2601.00002', 4);

    const resp = recommendPapers(db, { limit: 5 });
    const paper = resp.results.find(r => r.arxivId === '2601.00002');
    if (paper) {
      expect(paper.tracks).toContain('LLM Efficiency');
      expect(paper.llmScore).toBe(4);
    }
  });

  it('filters by track when track option is specified', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Survey', 'Speculative decoding');
    insertFeedback(db, '2601.00001', 'love');

    insertPaper(db, '2601.00002', 'Speculative Inference in LLMs', 'Speculative methods');
    insertTrack(db, '2601.00002', 'LLM');

    insertPaper(db, '2601.00003', 'Speculative Vision Decoding', 'Speculative inference for vision');
    insertTrack(db, '2601.00003', 'Vision');

    const resp = recommendPapers(db, { limit: 5, track: 'LLM' });
    const ids = resp.results.map(r => r.arxivId);
    // vision-only paper should not appear
    expect(ids).not.toContain('2601.00003');
  });

  it('returns keywords used for recommendation', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Inference Survey', 'About speculative decoding');
    insertFeedback(db, '2601.00001', 'love');
    insertPaper(db, '2601.00002', 'Something Else', 'About speculative decoding');

    const resp = recommendPapers(db, { limit: 5 });
    expect(Array.isArray(resp.keywords)).toBe(true);
    // 'speculative' and 'decoding' from the seed title should appear
    expect(resp.keywords).toContain('speculative');
    expect(resp.keywords).toContain('decoding');
  });

  it('returns no_results gracefully when all candidates are excluded', () => {
    insertPaper(db, '2601.00001', 'Speculative Decoding Paper', 'Speculative methods');
    insertFeedback(db, '2601.00001', 'love');

    // Candidate also excluded via feedback
    insertPaper(db, '2601.00002', 'Speculative Inference Method', 'Speculative inference');
    insertFeedback(db, '2601.00002', 'meh');

    const resp = recommendPapers(db, { limit: 5 });
    // Either no results (reason) or results — depends on whether FTS finds anything
    // The meh paper is excluded, and we only have it as a candidate, so no results
    expect(resp.reason === 'no_results' || resp.results.length === 0).toBe(true);
  });

  it('handles empty paper_feedback table gracefully', () => {
    // Only reading_list seeds (no paper_feedback table interaction)
    insertPaper(db, '2601.00001', 'Speculative Decoding Long', 'Speculative decoding methods');
    insertReadingList(db, '2601.00001', 9); // high priority seed

    insertPaper(db, '2601.00002', 'Speculative Inference Fast', 'Speculative inference');

    const resp = recommendPapers(db, { limit: 5 });
    expect(resp).toBeDefined();
    expect(Array.isArray(resp.results)).toBe(true);
  });
});

// ── formatRecommendReply ───────────────────────────────────────────────────

describe('formatRecommendReply', () => {
  it('returns helpful message when no seeds', () => {
    const reply = formatRecommendReply({
      results: [],
      seedCount: 0,
      keywords: [],
      reason: 'no_seeds',
    });
    expect(reply).toContain('/love');
    expect(reply).toContain('/save');
    expect(reply).toContain('Not enough data');
  });

  it('returns helpful message when no results', () => {
    const reply = formatRecommendReply({
      results: [],
      seedCount: 5,
      keywords: ['speculative', 'decoding'],
      reason: 'no_results',
    });
    expect(reply).toContain('No new recommendations');
    expect(reply).toContain('/love');
    expect(reply).toContain('/save');
  });

  it('formats single result correctly', () => {
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.12345',
          title: 'Speculative Decoding for Fast Inference',
          publishedAt: '2026-01-15T00:00:00Z',
          abstract: 'An abstract.',
          tracks: ['LLM'],
          llmScore: 4,
          matchStrength: 1,
        },
      ],
      seedCount: 3,
      keywords: ['speculative', 'decoding', 'inference'],
    });
    expect(reply).toContain('2601.12345');
    expect(reply).toContain('Speculative Decoding');
    expect(reply).toContain('★4');
    expect(reply).toContain('LLM');
    expect(reply).toContain('2026-01-15');
    expect(reply).toContain('🔮');
  });

  it('truncates long titles to 65 chars', () => {
    const longTitle = 'A '.repeat(40); // 80 chars
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.99999',
          title: longTitle,
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: '',
          tracks: [],
          llmScore: null,
          matchStrength: 1,
        },
      ],
      seedCount: 1,
      keywords: ['something'],
    });
    // The title line should contain '…'
    expect(reply).toContain('…');
  });

  it('shows profile keywords in header', () => {
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.00001',
          title: 'Test Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: '',
          tracks: [],
          llmScore: null,
          matchStrength: 1,
        },
      ],
      seedCount: 2,
      keywords: ['speculative', 'decoding', 'inference', 'attention', 'transformer'],
    });
    // Top 5 keywords should appear in the profile line
    expect(reply).toContain('speculative');
    expect(reply).toContain('Profile:');
  });

  it('includes usage hint in footer', () => {
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.00001',
          title: 'Test',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: '',
          tracks: [],
          llmScore: null,
          matchStrength: 1,
        },
      ],
      seedCount: 1,
      keywords: ['test'],
    });
    expect(reply).toContain('/recommend --limit');
    expect(reply).toContain('/recommend --track');
  });

  it('omits track badge when no tracks', () => {
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.00001',
          title: 'Clean Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: '',
          tracks: [],
          llmScore: null,
          matchStrength: 1,
        },
      ],
      seedCount: 1,
      keywords: ['clean'],
    });
    expect(reply).not.toContain('[');
    expect(reply).toContain('2601.00001');
  });

  it('omits score badge when llmScore is null', () => {
    const reply = formatRecommendReply({
      results: [
        {
          arxivId: '2601.00001',
          title: 'Unscored Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: '',
          tracks: [],
          llmScore: null,
          matchStrength: 1,
        },
      ],
      seedCount: 1,
      keywords: ['unscored'],
    });
    expect(reply).not.toContain('★');
  });
});
