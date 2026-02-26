/**
 * Tests for the unified FTS5 paper search (search.ts).
 *
 * Covers:
 *   • sanitiseQuery — query string cleaning
 *   • searchPapers  — core search (FTS5, ranking, all filters, result shape)
 *   • formatSearchReply — compact Signal formatter
 *   • renderSearchMessage — rich Signal formatter (excerpt, URL, emoji scores)
 *   • renderSearchCompact — one-liner summary
 *
 * Uses an in-memory SQLite DB with the full migration stack applied via
 * migrate(), so we test real FTS5 behaviour (porter stemming, triggers).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import {
  searchPapers,
  sanitiseQuery,
  formatSearchReply,
  renderSearchMessage,
  renderSearchCompact,
} from './search.js';
import type { Db } from '../db.js';
import type { SearchResponse, SearchResult } from './search.js';

// ── DB helpers ─────────────────────────────────────────────────────────────────

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
}

function seedTrack(db: Db, arxivId: string, trackName: string, score = 70): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '[]', datetime('now'))`,
    )
    .run(arxivId, trackName, score);
}

function seedScore(db: Db, arxivId: string, score: number, reasoning = 'test'): void {
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO llm_scores (arxiv_id, relevance_score, reasoning, scored_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(arxivId, score, reasoning);
}

// ── sanitiseQuery ──────────────────────────────────────────────────────────────

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
    // In FTS5, `high-quality` parses as `high AND NOT quality`.
    // We convert to `high quality` (AND semantics) instead.
    expect(sanitiseQuery('high-quality LoRA')).toBe('high quality LoRA');
  });

  it('handles leading/trailing whitespace', () => {
    expect(sanitiseQuery('  RAG  ')).toBe('RAG');
  });

  it('returns empty string for blank input', () => {
    expect(sanitiseQuery('')).toBe('');
    expect(sanitiseQuery('   ')).toBe('');
  });

  it('collapses multiple internal spaces', () => {
    expect(sanitiseQuery('RAG   retrieval  augmented')).toBe('RAG retrieval augmented');
  });
});

// ── searchPapers — basic ───────────────────────────────────────────────────────

describe('searchPapers — basic matching', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns empty results for a query with no matches', () => {
    seedPaper(db, '2601.00001', 'Attention Is All You Need', 'Transformer architecture.');
    const resp = searchPapers(db, { query: 'quantum computing' });
    expect(resp.results).toHaveLength(0);
    expect(resp.totalCount).toBe(0);
    expect(resp.query).toBe('quantum computing');
  });

  it('returns empty for blank query', () => {
    const resp = searchPapers(db, { query: '' });
    expect(resp.count).toBe(0);
    expect(resp.results).toHaveLength(0);
  });

  it('returns empty for whitespace-only query', () => {
    const resp = searchPapers(db, { query: '   ' });
    expect(resp.count).toBe(0);
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
      db, '2601.00002', 'Fast Inference',
      'We demonstrate speculating tokens to reduce latency in large language model generation.',
    );
    // "speculate" stems the same as "speculative"
    const resp = searchPapers(db, { query: 'speculate' });
    expect(resp.results.some((r) => r.arxivId === '2601.00002')).toBe(true);
  });

  it('finds paper by abstract keyword (multi-term)', () => {
    seedPaper(
      db, '2601.00003', 'RAG-Fusion: Improved Retrieval-Augmented Generation',
      'This paper introduces RAG-Fusion for retrieval augmented generation, combining multiple strategies.',
    );
    const resp = searchPapers(db, { query: 'retrieval augmented generation' });
    expect(resp.results.some((r) => r.arxivId === '2601.00003')).toBe(true);
  });

  it('handles FTS5 syntax errors gracefully — returns empty, never throws', () => {
    seedPaper(db, '2601.99999', 'LoRA Paper', 'Low-rank adaptation.');
    const resp = searchPapers(db, { query: '(((' });
    expect(resp.results).toHaveLength(0);
  });

  it('FTS trigger auto-inserts new papers into the index', () => {
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
});

// ── searchPapers — result shape ────────────────────────────────────────────────

describe('searchPapers — result shape', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    const longAbstract = 'A '.repeat(150) + 'long abstract that exceeds two hundred characters.';
    seedPaper(db, '2601.12345', 'Efficient Inference via Speculative Sampling', longAbstract, '2026-01-15T00:00:00Z');
    seedTrack(db, '2601.12345', 'LLM Efficiency', 90);
    seedScore(db, '2601.12345', 4, 'Solid inference optimization work');
  });

  it('result has all required fields', () => {
    const resp = searchPapers(db, { query: 'speculative sampling' });
    expect(resp.count).toBeGreaterThanOrEqual(1);
    const r = resp.results[0]!;
    expect(r.arxivId).toBe('2601.12345');
    expect(r.title).toBe('Efficient Inference via Speculative Sampling');
    expect(r.publishedAt).toBe('2026-01-15T00:00:00Z');
    expect(typeof r.abstract).toBe('string');
    expect(r.excerpt.length).toBeLessThanOrEqual(203); // 200 + '…'
    expect(r.tracks).toContain('LLM Efficiency');
    expect(r.llmScore).toBe(4);
    expect(r.llmReasoning).toBe('Solid inference optimization work');
    expect(r.keywordScore).toBe(90);
    expect(r.absUrl).toBe('https://arxiv.org/abs/2601.12345');
  });

  it('excerpt is truncated to ~200 chars with ellipsis when abstract is long', () => {
    const resp = searchPapers(db, { query: 'speculative sampling' });
    const r = resp.results[0]!;
    expect(r.excerpt.endsWith('…')).toBe(true);
    expect(r.excerpt.length).toBeLessThanOrEqual(203);
  });

  it('excerpt is the full abstract when it fits within 200 chars', () => {
    seedPaper(db, '2601.22222', 'Short Abstract Paper', 'This is a short abstract.', '2026-01-15T00:00:00Z');
    const resp = searchPapers(db, { query: 'short abstract' });
    const r = resp.results.find((x) => x.arxivId === '2601.22222');
    expect(r?.excerpt).toBe('This is a short abstract.');
    expect(r?.excerpt.endsWith('…')).toBe(false);
  });

  it('kind discriminant is searchResults', () => {
    const resp = searchPapers(db, { query: 'speculative sampling' });
    expect(resp.kind).toBe('searchResults');
  });

  it('count matches results array length', () => {
    const resp = searchPapers(db, { query: 'speculative sampling' });
    expect(resp.count).toBe(resp.results.length);
  });

  it('absUrl is correct arXiv link', () => {
    const resp = searchPapers(db, { query: 'speculative sampling' });
    expect(resp.results[0]?.absUrl).toBe('https://arxiv.org/abs/2601.12345');
  });

  it('llmScore is null when paper is not scored', () => {
    seedPaper(db, '2601.33333', 'Unscored LoRA Paper', 'Low-rank adaptation study, no score yet.');
    const resp = searchPapers(db, { query: 'LoRA unscored' });
    const r = resp.results.find((x) => x.arxivId === '2601.33333');
    expect(r?.llmScore).toBeNull();
    expect(r?.llmReasoning).toBeNull();
  });

  it('keywordScore is 0 when paper has no track_matches', () => {
    seedPaper(db, '2601.44444', 'Untracked Inference Paper', 'Fast inference methods, no track.');
    const resp = searchPapers(db, { query: 'untracked inference' });
    const r = resp.results.find((x) => x.arxivId === '2601.44444');
    expect(r?.keywordScore).toBe(0);
    expect(r?.tracks).toEqual([]);
  });

  it('includes all track names for a multi-track paper', () => {
    seedPaper(db, '2601.55555', 'Multi-Track Paper on Efficiency', 'Covers efficiency and alignment.');
    seedTrack(db, '2601.55555', 'LLM Efficiency', 80);
    seedTrack(db, '2601.55555', 'Alignment & Safety', 60);
    const resp = searchPapers(db, { query: 'efficiency alignment' });
    const r = resp.results.find((x) => x.arxivId === '2601.55555');
    expect(r?.tracks).toContain('LLM Efficiency');
    expect(r?.tracks).toContain('Alignment & Safety');
  });
});

// ── searchPapers — limit ───────────────────────────────────────────────────────

describe('searchPapers — limit', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('default limit is 5', () => {
    for (let i = 1; i <= 10; i++) {
      seedPaper(db, `2602.2000${i}`, `MoE Paper ${i}`, `Mixture of experts model study ${i}.`);
    }
    const resp = searchPapers(db, { query: 'mixture experts' });
    expect(resp.results).toHaveLength(5);
    expect(resp.totalCount).toBe(10);
  });

  it('respects custom limit', () => {
    for (let i = 1; i <= 8; i++) {
      seedPaper(db, `2601.0000${i}`, `LoRA Paper ${i}`, `Low-rank adaptation method paper ${i}.`);
    }
    const resp = searchPapers(db, { query: 'LoRA', limit: 3 });
    expect(resp.results).toHaveLength(3);
    expect(resp.totalCount).toBe(8);
  });

  it('clamps limit to max 20', () => {
    for (let i = 0; i < 25; i++) {
      seedPaper(db, `2501.0${100 + i}`, `Paper ${i} about language models`, `Abstract about language model training ${i}.`);
    }
    const resp = searchPapers(db, { query: 'language models', limit: 99 });
    expect(resp.results.length).toBeLessThanOrEqual(20);
  });
});

// ── searchPapers — ranking ─────────────────────────────────────────────────────

describe('searchPapers — ranking', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    // Paper A: llm_score 5 — should rank first
    seedPaper(db, '2501.00010', 'Transformer Architecture Improvements', 'Advances in transformer architecture for language modeling.');
    seedScore(db, '2501.00010', 5, 'top-tier');
    seedTrack(db, '2501.00010', 'Architecture', 80);
    // Paper B: llm_score 3
    seedPaper(db, '2501.00011', 'Transformer Fine-tuning Survey', 'A survey of fine-tuning methods for transformer models.');
    seedScore(db, '2501.00011', 3, 'decent');
    seedTrack(db, '2501.00011', 'Fine-tuning', 60);
    // Paper C: llm_score 4
    seedPaper(db, '2501.00012', 'Efficient Transformer Training', 'Efficient training strategies for large transformer models.');
    seedScore(db, '2501.00012', 4, 'good');
    seedTrack(db, '2501.00012', 'Training', 70);
  });

  it('orders results by llm_score descending (score 5 before 4 before 3)', () => {
    const resp = searchPapers(db, { query: 'transformer' });
    expect(resp.count).toBeGreaterThanOrEqual(3);
    const scores = resp.results.map((r) => r.llmScore);
    expect(scores[0]).toBe(5);
    for (let i = 1; i < scores.length; i++) {
      expect((scores[i] ?? 0)).toBeLessThanOrEqual((scores[i - 1] ?? 0));
    }
  });

  it('unscored papers come after scored papers', () => {
    seedPaper(db, '2501.00013', 'Another Transformer Paper', 'More transformer architecture work.');
    // No score for 00013
    const resp = searchPapers(db, { query: 'transformer' });
    const ids = resp.results.map((r) => r.arxivId);
    const unscoredIdx = ids.indexOf('2501.00013');
    if (unscoredIdx !== -1) {
      // All papers before it should have a score
      for (let i = 0; i < unscoredIdx; i++) {
        expect(resp.results[i]!.llmScore).not.toBeNull();
      }
    }
  });
});

// ── searchPapers — filter: from (date) ────────────────────────────────────────

describe('searchPapers — from (date filter)', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    seedPaper(db, '2601.11111', 'Old LoRA Paper', 'Low-rank adaptation.', '2024-06-01T00:00:00Z');
    seedPaper(db, '2601.22222', 'New LoRA Paper', 'Low-rank adaptation.', '2026-01-01T00:00:00Z');
  });

  it('excludes papers before the from date', () => {
    const resp = searchPapers(db, { query: 'LoRA', from: '2025' });
    expect(resp.results.some((r) => r.arxivId === '2601.22222')).toBe(true);
    expect(resp.results.some((r) => r.arxivId === '2601.11111')).toBe(false);
  });

  it('includes all papers when from is null', () => {
    const resp = searchPapers(db, { query: 'LoRA', from: null });
    const ids = resp.results.map((r) => r.arxivId);
    expect(ids).toContain('2601.11111');
    expect(ids).toContain('2601.22222');
  });

  it('from prefix "2026" includes January 2026 papers', () => {
    const resp = searchPapers(db, { query: 'LoRA', from: '2026' });
    expect(resp.results.some((r) => r.arxivId === '2601.22222')).toBe(true);
    expect(resp.results.some((r) => r.arxivId === '2601.11111')).toBe(false);
  });
});

// ── searchPapers — filter: track ───────────────────────────────────────────────

describe('searchPapers — track filter', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    seedPaper(db, '2601.33333', 'Speculative Decoding Paper', 'Fast inference for LLMs.');
    seedPaper(db, '2601.44444', 'Another Speculative Paper', 'Speculation in generation models.');
    seedTrack(db, '2601.33333', 'LLM');
    // 2601.44444 has no track match
  });

  it('returns only papers with matching track', () => {
    const resp = searchPapers(db, { query: 'speculative', track: 'LLM' });
    expect(resp.results.some((r) => r.arxivId === '2601.33333')).toBe(true);
    expect(resp.results.some((r) => r.arxivId === '2601.44444')).toBe(false);
  });

  it('track filter is case-insensitive', () => {
    const resp = searchPapers(db, { query: 'speculative', track: 'llm' });
    expect(resp.results.some((r) => r.arxivId === '2601.33333')).toBe(true);
  });

  it('track filter is partial-match (substring)', () => {
    seedPaper(db, '2601.55555', 'LoRA Efficiency Paper', 'Low-rank adaptation.');
    seedTrack(db, '2601.55555', 'LLM Efficiency');
    const resp = searchPapers(db, { query: 'LoRA efficiency', track: 'Efficiency' });
    expect(resp.results.some((r) => r.arxivId === '2601.55555')).toBe(true);
  });

  it('returns empty when no papers match the track', () => {
    const resp = searchPapers(db, { query: 'speculative', track: 'Protein Folding' });
    expect(resp.results).toHaveLength(0);
  });
});

// ── searchPapers — filter: minLlmScore ────────────────────────────────────────

describe('searchPapers — minLlmScore filter', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    seedPaper(db, '2501.00020', 'Low-rank Adaptation for LLMs', 'LoRA and QLoRA methods for fine-tuning.');
    seedPaper(db, '2501.00021', 'Prefix Tuning for Language Models', 'Prefix tuning as an alternative to fine-tuning.');
    seedScore(db, '2501.00020', 5);
    seedScore(db, '2501.00021', 2);
  });

  it('respects minLlmScore filter — only returns papers at or above threshold', () => {
    const resp = searchPapers(db, { query: 'language models', minLlmScore: 4 });
    for (const r of resp.results) {
      expect(r.llmScore).not.toBeNull();
      expect(r.llmScore!).toBeGreaterThanOrEqual(4);
    }
  });

  it('minLlmScore 1 includes all scored papers (both have score >= 1)', () => {
    // Both papers have "fine" and "tuning" in their abstracts — the hyphen is
    // converted to space by sanitiseQuery, so "fine-tuning" → "fine tuning" (AND)
    const resp = searchPapers(db, { query: 'fine-tuning', minLlmScore: 1 });
    const ids = resp.results.map((r) => r.arxivId);
    expect(ids).toContain('2501.00020');
    expect(ids).toContain('2501.00021');
  });

  it('minLlmScore 5 returns only perfect papers', () => {
    const resp = searchPapers(db, { query: 'language models', minLlmScore: 5 });
    expect(resp.results.every((r) => r.llmScore === 5)).toBe(true);
  });
});

// ── searchPapers — porter stemming ────────────────────────────────────────────

describe('searchPapers — porter stemming', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    seedPaper(
      db, '2501.00030', 'Training Large Language Models at Scale',
      'We present techniques for training large neural networks efficiently using distributed computing.',
    );
  });

  it('matches stemmed forms: "train" → "training"', () => {
    const resp = searchPapers(db, { query: 'train' });
    expect(resp.count).toBeGreaterThanOrEqual(1);
  });

  it('matches plural forms: "network" → "networks"', () => {
    const resp = searchPapers(db, { query: 'network' });
    expect(resp.count).toBeGreaterThanOrEqual(1);
  });
});

// ── formatSearchReply ──────────────────────────────────────────────────────────

describe('formatSearchReply', () => {
  function makeResp(overrides: Partial<SearchResponse> = {}): SearchResponse {
    return {
      kind: 'searchResults',
      results: [],
      totalCount: 0,
      count: 0,
      query: 'test query',
      ...overrides,
    };
  }

  function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
      arxivId: '2601.12345',
      title: 'Test Paper',
      publishedAt: '2026-01-01T00:00:00Z',
      abstract: 'Full abstract text.',
      excerpt: 'Full abstract text.',
      tracks: [],
      llmScore: null,
      llmReasoning: null,
      keywordScore: 0,
      absUrl: 'https://arxiv.org/abs/2601.12345',
      ...overrides,
    };
  }

  it('shows a no-results message with example commands', () => {
    const reply = formatSearchReply(makeResp());
    expect(reply).toContain('No results');
    expect(reply).toContain('"test query"');
    expect(reply).toContain('/search');
  });

  it('shows total count and result count in header when truncated', () => {
    const resp = makeResp({
      query: 'speculative decoding',
      totalCount: 47,
      count: 1,
      results: [
        makeResult({
          arxivId: '2601.00001',
          title: 'Nightjar: Speculative Decoding',
          publishedAt: '2025-12-27T00:00:00Z',
          tracks: ['LLM'],
          llmScore: 4,
        }),
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('1 of 47');
    expect(reply).toContain('"speculative decoding"');
  });

  it('shows exact count when results exhaust totalCount', () => {
    const resp = makeResp({
      query: 'LoRA',
      totalCount: 2,
      count: 2,
      results: [
        makeResult({ arxivId: '2601.00001', title: 'LoRA Paper A', publishedAt: '2026-01-01T00:00:00Z' }),
        makeResult({ arxivId: '2601.00002', title: 'LoRA Paper B', publishedAt: '2026-01-02T00:00:00Z' }),
      ],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('2 results');
    expect(reply).not.toContain('More:');
  });

  it('shows arxiv ID for each result', () => {
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult({ arxivId: '2601.12345' })],
    });
    expect(formatSearchReply(resp)).toContain('arxiv:2601.12345');
  });

  it('shows LLM score badge ★N when available', () => {
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult({ llmScore: 5 })],
    });
    expect(formatSearchReply(resp)).toContain('★5');
  });

  it('shows track badge [TrackName] when present', () => {
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult({ tracks: ['Efficiency'] })],
    });
    expect(formatSearchReply(resp)).toContain('[Efficiency]');
  });

  it('truncates long titles to 65 chars', () => {
    const longTitle = 'A Very Long Paper Title That Exceeds Sixty-Five Characters Without A Doubt';
    expect(longTitle.length).toBeGreaterThan(65);
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult({ title: longTitle })],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('…');
    const titleLine = reply.split('\n').find((l) => l.match(/^1\./));
    expect(titleLine).toBeDefined();
    const titlePart = titleLine!.replace(/^1\.\s+/, '');
    expect(titlePart.length).toBeLessThanOrEqual(75);
  });

  it('shows "More:" hint when results were truncated', () => {
    const resp = makeResp({
      query: 'LoRA', totalCount: 50, count: 1,
      results: [makeResult()],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('More:');
    expect(reply).toContain('--limit 10');
  });

  it('includes command hints at the bottom', () => {
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult()],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('/save');
    expect(reply).toContain('/read');
    expect(reply).toContain('/love');
  });

  it('renders date as YYYY-MM-DD only', () => {
    const resp = makeResp({
      query: 'test', totalCount: 1, count: 1,
      results: [makeResult({ publishedAt: '2026-01-15T18:30:00.000Z' })],
    });
    const reply = formatSearchReply(resp);
    expect(reply).toContain('2026-01-15');
    expect(reply).not.toContain('18:30');
  });

  it('handles singular "result" vs plural "results"', () => {
    const single = makeResp({ query: 'LoRA', totalCount: 1, count: 1, results: [makeResult()] });
    expect(formatSearchReply(single)).toContain('1 result');
    expect(formatSearchReply(single)).not.toContain('1 results');
  });
});

// ── renderSearchMessage ────────────────────────────────────────────────────────

describe('renderSearchMessage — empty results', () => {
  function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
    return { kind: 'searchResults', query: 'test', count: 0, totalCount: 0, results: [], ...overrides };
  }

  it('shows "No papers found" message', () => {
    const { text } = renderSearchMessage(makeResponse({ query: 'protein folding' }));
    expect(text).toContain('No papers found');
    expect(text).toContain('protein folding');
  });

  it('includes query in header', () => {
    const { text } = renderSearchMessage(makeResponse({ query: 'my test query' }));
    expect(text).toContain('my test query');
  });

  it('includes helpful tip for empty results', () => {
    const { text } = renderSearchMessage(makeResponse({ query: 'nothing' }));
    expect(text).toContain('/weekly');
  });
});

describe('renderSearchMessage — single result', () => {
  function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
    return {
      arxivId: '2501.12345',
      title: 'Test Paper Title',
      excerpt: 'This is the abstract excerpt for the test paper.',
      abstract: 'This is the abstract excerpt for the test paper.',
      publishedAt: '2026-01-15T00:00:00Z',
      llmScore: 4,
      llmReasoning: 'Good paper',
      keywordScore: 75,
      tracks: ['LLM Efficiency'],
      absUrl: 'https://arxiv.org/abs/2501.12345',
      ...overrides,
    };
  }

  function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
    return { kind: 'searchResults', query: 'speculative', count: 1, totalCount: 1, results: [makeResult()], ...overrides };
  }

  it('shows result count', () => {
    const { text } = renderSearchMessage(makeResponse());
    expect(text).toContain('1 result');
  });

  it('shows title', () => {
    const { text } = renderSearchMessage(makeResponse({ results: [makeResult({ title: 'SpecTr: Fast Speculative Decoding' })] }));
    expect(text).toContain('SpecTr: Fast Speculative Decoding');
  });

  it('shows LLM score 5 with 🔥 emoji', () => {
    const { text } = renderSearchMessage(makeResponse({ results: [makeResult({ llmScore: 5 })] }));
    expect(text).toContain('5/5');
    expect(text).toContain('🔥');
  });

  it('shows track names', () => {
    const { text } = renderSearchMessage(makeResponse({ results: [makeResult({ tracks: ['LLM Efficiency'] })] }));
    expect(text).toContain('LLM Efficiency');
  });

  it('shows abstract excerpt', () => {
    const { text } = renderSearchMessage(makeResponse({
      results: [makeResult({ excerpt: 'We propose a new method for fast inference.' })],
    }));
    expect(text).toContain('We propose a new method');
  });

  it('shows arXiv URL', () => {
    const { text } = renderSearchMessage(makeResponse({
      results: [makeResult({ absUrl: 'https://arxiv.org/abs/2501.12345' })],
    }));
    expect(text).toContain('https://arxiv.org/abs/2501.12345');
  });

  it('shows footer with /weekly tip', () => {
    const { text } = renderSearchMessage(makeResponse());
    expect(text).toContain('/weekly');
    expect(text).toContain('/reading-list');
  });
});

describe('renderSearchMessage — score emoji', () => {
  function makeResult(score: number | null, kw = 0): SearchResult {
    return {
      arxivId: '2501.12345', title: 'Test', excerpt: 'x', abstract: 'x',
      publishedAt: '2026-01-01T00:00:00Z', llmScore: score, llmReasoning: null,
      keywordScore: kw, tracks: ['LLM'], absUrl: 'https://arxiv.org/abs/2501.12345',
    };
  }
  function makeResponse(r: SearchResult): SearchResponse {
    return { kind: 'searchResults', query: 'test', count: 1, totalCount: 1, results: [r] };
  }

  it('🔥 for score 5', () => {
    const { text } = renderSearchMessage(makeResponse(makeResult(5)));
    expect(text).toContain('🔥');
  });

  it('⭐ for score 4', () => {
    const { text } = renderSearchMessage(makeResponse(makeResult(4)));
    expect(text).toContain('⭐');
  });

  it('📌 for score 3', () => {
    const { text } = renderSearchMessage(makeResponse(makeResult(3)));
    expect(text).toContain('📌');
  });

  it('shows kw:N when no llm score but has keyword score', () => {
    const { text } = renderSearchMessage(makeResponse(makeResult(null, 88)));
    expect(text).toContain('kw:88');
  });

  it('handles null llmScore + zero keywordScore gracefully', () => {
    const { text } = renderSearchMessage(makeResponse(makeResult(null, 0)));
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('renderSearchMessage — multiple results', () => {
  function makeResult(arxivId: string, title: string): SearchResult {
    return {
      arxivId, title, excerpt: 'Abstract.', abstract: 'Abstract.',
      publishedAt: '2026-01-01T00:00:00Z', llmScore: null, llmReasoning: null,
      keywordScore: 0, tracks: [], absUrl: `https://arxiv.org/abs/${arxivId}`,
    };
  }

  it('numbers results 1, 2, 3', () => {
    const results = [
      makeResult('2501.00001', 'Paper Alpha'),
      makeResult('2501.00002', 'Paper Beta'),
      makeResult('2501.00003', 'Paper Gamma'),
    ];
    const resp: SearchResponse = { kind: 'searchResults', query: 'test', count: 3, totalCount: 3, results };
    const { text } = renderSearchMessage(resp);
    expect(text).toContain('1. Paper Alpha');
    expect(text).toContain('2. Paper Beta');
    expect(text).toContain('3. Paper Gamma');
  });

  it('uses plural "results" for count > 1', () => {
    const results = [makeResult('2501.00001', 'A'), makeResult('2501.00002', 'B')];
    const resp: SearchResponse = { kind: 'searchResults', query: 'test', count: 2, totalCount: 2, results };
    const { text } = renderSearchMessage(resp);
    expect(text).toContain('2 results');
  });

  it('uses singular "result" for count 1', () => {
    const results = [makeResult('2501.00001', 'A')];
    const resp: SearchResponse = { kind: 'searchResults', query: 'test', count: 1, totalCount: 1, results };
    const { text } = renderSearchMessage(resp);
    expect(text).toMatch(/1 result[^s]/);
  });

  it('does not produce excessively long messages', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult(`2501.0000${i}`, 'A Very Long Paper Title That Goes On And On About Deep Learning'),
    ).map((r) => ({ ...r, excerpt: 'x'.repeat(500) }));
    const resp: SearchResponse = { kind: 'searchResults', query: 'test', count: 5, totalCount: 5, results };
    const { text } = renderSearchMessage(resp);
    expect(text.length).toBeLessThan(10_000);
  });
});

// ── renderSearchCompact ────────────────────────────────────────────────────────

describe('renderSearchCompact', () => {
  function makeResponse(overrides: Partial<SearchResponse>): SearchResponse {
    return { kind: 'searchResults', query: 'test', count: 0, totalCount: 0, results: [], ...overrides };
  }

  it('returns compact string for no results', () => {
    const text = renderSearchCompact(makeResponse({ query: 'foo', count: 0, results: [] }));
    expect(text).toContain('no results');
    expect(text).toContain('foo');
  });

  it('returns count and top score', () => {
    const r: SearchResult = {
      arxivId: '2501.12345', title: 'T', excerpt: 'x', abstract: 'x',
      publishedAt: '2026-01-01T00:00:00Z', llmScore: 5, llmReasoning: null,
      keywordScore: 0, tracks: [], absUrl: 'https://arxiv.org/abs/2501.12345',
    };
    const text = renderSearchCompact(makeResponse({ query: 'bar', count: 1, results: [r] }));
    expect(text).toContain('1 result');
    expect(text).toContain('5/5');
    expect(text).toContain('bar');
  });

  it('omits score when top result has no llm score', () => {
    const r: SearchResult = {
      arxivId: '2501.12345', title: 'T', excerpt: 'x', abstract: 'x',
      publishedAt: '2026-01-01T00:00:00Z', llmScore: null, llmReasoning: null,
      keywordScore: 0, tracks: [], absUrl: 'https://arxiv.org/abs/2501.12345',
    };
    const text = renderSearchCompact(makeResponse({ query: 'baz', count: 1, results: [r] }));
    expect(text).not.toContain('/5');
  });
});
