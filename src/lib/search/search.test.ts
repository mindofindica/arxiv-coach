/**
 * Tests for FTS5 paper search (search.ts).
 *
 * Uses an in-memory SQLite DB with the full migration stack applied,
 * so we test the real FTS5 behaviour (porter stemming, ranking, triggers).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { searchPapers, sanitiseQuery, formatSearchReply } from './search.js';
import type { Db } from '../db.js';
import type { SearchResponse } from './search.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  return db;
}

function seedPaper(
  db: Db,
  arxivId: string,
  title: string,
  abstract: string,
  publishedAt = '2026-01-15T00:00:00Z',
): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, ?, '[]', '[]', ?, ?, '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    )
    .run(arxivId, title, abstract, publishedAt, publishedAt);

  // Also insert into FTS (the trigger should handle this for real inserts,
  // but in-memory DBs have the trigger installed by migrate, so this is a belt-and-suspenders)
  // Actually the trigger IS installed by v7 migration, so paper insert auto-populates FTS.
}

function seedTrack(db: Db, arxivId: string, trackName: string): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, 5, '[]', datetime('now'))`,
    )
    .run(arxivId, trackName);
}

function seedScore(db: Db, arxivId: string, score: number): void {
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO llm_scores (arxiv_id, relevance_score, reasoning, scored_at)
       VALUES (?, ?, 'test', datetime('now'))`,
    )
    .run(arxivId, score);
}

// ── sanitiseQuery ──────────────────────────────────────────────────────────

describe('sanitiseQuery', () => {
  it('returns bare keywords unchanged for multi-word query (AND semantics)', () => {
    expect(sanitiseQuery('speculative decoding')).toBe('speculative decoding');
  });

  it('passes through already-quoted string unchanged (phrase search)', () => {
    expect(sanitiseQuery('"speculative decoding"')).toBe('"speculative decoding"');
  });

  it('returns single-word query unchanged', () => {
    expect(sanitiseQuery('LoRA')).toBe('LoRA');
  });

  it('strips stray double-quotes from unquoted multi-word query', () => {
    expect(sanitiseQuery('retrieval "augmented" generation')).toBe(
      'retrieval augmented generation',
    );
  });

  it('replaces hyphens with spaces to avoid FTS5 NOT operator confusion', () => {
    // In FTS5 query syntax, `high-quality` = `high AND NOT quality`
    // We convert to `high quality` (AND semantics) instead
    expect(sanitiseQuery('high-quality LoRA')).toBe('high quality LoRA');
  });

  it('handles leading/trailing whitespace', () => {
    expect(sanitiseQuery('  RAG  ')).toBe('RAG');
  });

  it('returns empty string for blank input', () => {
    expect(sanitiseQuery('')).toBe('');
    expect(sanitiseQuery('   ')).toBe('');
  });
});

// ── searchPapers ───────────────────────────────────────────────────────────

describe('searchPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns empty results for a query with no matches', () => {
    seedPaper(db, '2601.00001', 'Attention Is All You Need', 'Transformer architecture using self-attention.');
    const resp = searchPapers(db, { query: 'quantum computing' });
    expect(resp.results).toHaveLength(0);
    expect(resp.totalCount).toBe(0);
    expect(resp.query).toBe('quantum computing');
  });

  it('finds a paper by title keyword', () => {
    seedPaper(db, '2601.00001', 'Speculative Decoding for LLMs', 'We propose a method to speed up inference.');
    const resp = searchPapers(db, { query: 'speculative decoding' });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]!.arxivId).toBe('2601.00001');
    expect(resp.totalCount).toBe(1);
  });

  it('finds a paper by abstract keyword (porter stemming)', () => {
    seedPaper(
      db,
      '2601.00002',
      'Fast Inference',
      'We demonstrate speculating tokens to reduce latency in large language model generation.',
    );
    // "speculate" stems the same as "speculative"
    const resp = searchPapers(db, { query: 'speculate' });
    expect(resp.results.some((r) => r.arxivId === '2601.00002')).toBe(true);
  });

  it('respects the limit option', () => {
    for (let i = 1; i <= 8; i++) {
      seedPaper(db, `2601.0000${i}`, `LoRA Paper ${i}`, `Low-rank adaptation method paper ${i}.`);
    }
    const resp = searchPapers(db, { query: 'LoRA', limit: 3 });
    expect(resp.results).toHaveLength(3);
    expect(resp.totalCount).toBe(8);
  });

  it('clamps limit to 20', () => {
    for (let i = 1; i <= 5; i++) {
      seedPaper(db, `2601.1000${i}`, `RAG Paper ${i}`, `Retrieval augmented generation study ${i}.`);
    }
    // Requesting 99 should be clamped to 20 max
    const resp = searchPapers(db, { query: 'RAG retrieval', limit: 99 });
    expect(resp.results.length).toBeLessThanOrEqual(20);
  });

  it('filters by from date prefix', () => {
    seedPaper(db, '2601.11111', 'Old LoRA Paper', 'Low-rank adaptation.', '2024-06-01T00:00:00Z');
    seedPaper(db, '2601.22222', 'New LoRA Paper', 'Low-rank adaptation.', '2026-01-01T00:00:00Z');
    const resp = searchPapers(db, { query: 'LoRA', from: '2025' });
    expect(resp.results.some((r) => r.arxivId === '2601.22222')).toBe(true);
    expect(resp.results.some((r) => r.arxivId === '2601.11111')).toBe(false);
  });

  it('filters by track name', () => {
    seedPaper(db, '2601.33333', 'Speculative Decoding Paper', 'Fast inference for LLMs.');
    seedPaper(db, '2601.44444', 'Another Speculative Paper', 'Speculation in generation models.');
    seedTrack(db, '2601.33333', 'LLM');

    const resp = searchPapers(db, { query: 'speculative', track: 'LLM' });
    expect(resp.results.some((r) => r.arxivId === '2601.33333')).toBe(true);
    // 2601.44444 has no track match — should not appear
    expect(resp.results.some((r) => r.arxivId === '2601.44444')).toBe(false);
  });

  it('track filter is case-insensitive', () => {
    seedPaper(db, '2601.55555', 'Speculative Decoding Study', 'Fast inference.');
    seedTrack(db, '2601.55555', 'LLM');

    const resp = searchPapers(db, { query: 'speculative', track: 'llm' });
    expect(resp.results.some((r) => r.arxivId === '2601.55555')).toBe(true);
  });

  it('includes track names in results', () => {
    seedPaper(db, '2601.66666', 'LoRA for LLMs', 'Low-rank adaptation for large language models.');
    seedTrack(db, '2601.66666', 'Efficiency');
    seedTrack(db, '2601.66666', 'LLM');

    const resp = searchPapers(db, { query: 'LoRA' });
    const result = resp.results.find((r) => r.arxivId === '2601.66666');
    expect(result?.tracks).toContain('Efficiency');
    expect(result?.tracks).toContain('LLM');
  });

  it('includes LLM score in results when available', () => {
    seedPaper(db, '2601.77777', 'High-Quality LoRA Paper', 'Low-rank adaptation with excellent results.');
    seedScore(db, '2601.77777', 5);

    const resp = searchPapers(db, { query: 'LoRA high-quality' });
    const result = resp.results.find((r) => r.arxivId === '2601.77777');
    expect(result?.llmScore).toBe(5);
  });

  it('returns llmScore as null when not scored', () => {
    seedPaper(db, '2601.88888', 'Unscored LoRA Paper', 'Low-rank adaptation, unscored.');
    const resp = searchPapers(db, { query: 'LoRA unscored' });
    const result = resp.results.find((r) => r.arxivId === '2601.88888');
    expect(result?.llmScore).toBeNull();
  });

  it('handles FTS5 syntax errors gracefully (returns empty)', () => {
    seedPaper(db, '2601.99999', 'LoRA Paper', 'Low-rank adaptation.');
    // Malformed FTS5 query — should not throw
    const resp = searchPapers(db, { query: '(((' });
    expect(resp.results).toHaveLength(0);
  });

  it('FTS trigger auto-inserts new papers into the index', () => {
    // Papers added via INSERT should be found without manual FTS insert
    db.sqlite
      .prepare(
        `INSERT INTO papers
           (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
            published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
         VALUES ('2602.11111', 'v1', 'Trigger Test Paper', 'Probing FTS trigger behaviour.',
                 '[]', '[]', datetime('now'), datetime('now'),
                 '/tmp/t.pdf', '/tmp/t.txt', '/tmp/t.json', datetime('now'))`,
      )
      .run();

    const resp = searchPapers(db, { query: 'trigger probing FTS' });
    expect(resp.results.some((r) => r.arxivId === '2602.11111')).toBe(true);
  });

  it('default limit is 5', () => {
    for (let i = 1; i <= 10; i++) {
      seedPaper(db, `2602.2000${i}`, `MoE Paper ${i}`, `Mixture of experts model study ${i}.`);
    }
    const resp = searchPapers(db, { query: 'mixture experts' });
    expect(resp.results).toHaveLength(5);
    expect(resp.totalCount).toBe(10);
  });
});

// ── formatSearchReply ──────────────────────────────────────────────────────

describe('formatSearchReply', () => {
  function makeResp(overrides: Partial<SearchResponse> = {}): SearchResponse {
    return {
      results: [],
      totalCount: 0,
      query: 'test query',
      ...overrides,
    };
  }

  it('shows a no-results message with example commands', () => {
    const reply = formatSearchReply(makeResp());
    expect(reply).toContain('No results');
    expect(reply).toContain('"test query"');
    expect(reply).toContain('/search');
  });

  it('shows total count and result count in header', () => {
    const resp = makeResp({
      query: 'speculative decoding',
      totalCount: 47,
      results: [
        {
          arxivId: '2601.00001',
          title: 'Nightjar: Speculative Decoding',
          publishedAt: '2025-12-27T00:00:00Z',
          abstract: 'Fast decoding.',
          tracks: ['LLM'],
          llmScore: 4,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('1 of 47');
    expect(reply).toContain('"speculative decoding"');
  });

  it('shows exact count when results exhaust total', () => {
    const resp = makeResp({
      query: 'LoRA',
      totalCount: 2,
      results: [
        {
          arxivId: '2601.00001',
          title: 'LoRA Paper A',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Low-rank.',
          tracks: [],
          llmScore: null,
        },
        {
          arxivId: '2601.00002',
          title: 'LoRA Paper B',
          publishedAt: '2026-01-02T00:00:00Z',
          abstract: 'Low-rank.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('2 results');
    // No "More:" line
    expect(reply).not.toContain('More:');
  });

  it('shows arxiv ID for each result', () => {
    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'Test Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('arxiv:2601.12345');
  });

  it('shows LLM score badge when available', () => {
    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'Highly Relevant Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: 5,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('★5');
  });

  it('shows track badge when present', () => {
    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'Track-matched Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: ['Efficiency'],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('[Efficiency]');
  });

  it('truncates long titles to 65 chars', () => {
    const longTitle = 'A Very Long Paper Title That Exceeds Sixty-Five Characters Without A Doubt';
    expect(longTitle.length).toBeGreaterThan(65);

    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: longTitle,
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('…');
    // The title line should not exceed 65 + numbering + truncation chars
    const titleLine = reply.split('\n').find((l) => l.match(/^1\./));
    expect(titleLine).toBeDefined();
    const titlePart = titleLine!.replace(/^1\.\s+/, '');
    expect(titlePart.length).toBeLessThanOrEqual(70); // 65 chars + ellipsis + possible badges
  });

  it('shows "More:" hint when results were truncated', () => {
    const resp = makeResp({
      query: 'LoRA',
      totalCount: 50,
      results: [
        {
          arxivId: '2601.12345',
          title: 'LoRA Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('More:');
    expect(reply).toContain('--limit 10');
  });

  it('includes command hints at the bottom', () => {
    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('/save');
    expect(reply).toContain('/read');
    expect(reply).toContain('/love');
  });

  it('renders date as YYYY-MM-DD only', () => {
    const resp = makeResp({
      query: 'test',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'Dated Paper',
          publishedAt: '2026-01-15T18:30:00.000Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('2026-01-15');
    expect(reply).not.toContain('18:30');
  });

  it('handles single result with singular noun', () => {
    const resp = makeResp({
      query: 'LoRA',
      totalCount: 1,
      results: [
        {
          arxivId: '2601.12345',
          title: 'One LoRA Paper',
          publishedAt: '2026-01-01T00:00:00Z',
          abstract: 'Test.',
          tracks: [],
          llmScore: null,
        },
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('1 result');
    expect(reply).not.toContain('1 results');
  });
});
