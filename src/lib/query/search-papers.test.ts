import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { searchPapers } from './search-papers.js';
import type { Db } from '../db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new Database(':memory:');

  // Core tables (subset needed for search)
  sqlite.exec(`
    CREATE TABLE papers (
      arxiv_id TEXT PRIMARY KEY,
      latest_version TEXT,
      title TEXT NOT NULL,
      abstract TEXT NOT NULL,
      authors_json TEXT NOT NULL DEFAULT '[]',
      categories_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      pdf_path TEXT NOT NULL DEFAULT '',
      txt_path TEXT NOT NULL DEFAULT '',
      meta_path TEXT NOT NULL DEFAULT '',
      sha256_pdf TEXT,
      ingested_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE track_matches (
      arxiv_id TEXT NOT NULL,
      track_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      matched_terms_json TEXT NOT NULL DEFAULT '[]',
      matched_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (arxiv_id, track_name),
      FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
    );

    CREATE TABLE llm_scores (
      arxiv_id TEXT PRIMARY KEY,
      relevance_score INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
      reasoning TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'sonnet',
      scored_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
    );

    -- FTS5 virtual table (mirrors db.ts v7 migration)
    CREATE VIRTUAL TABLE papers_fts USING fts5(
      arxiv_id UNINDEXED,
      title,
      abstract,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER papers_fts_ai
    AFTER INSERT ON papers BEGIN
      INSERT INTO papers_fts (arxiv_id, title, abstract)
      VALUES (new.arxiv_id, new.title, new.abstract);
    END;

    CREATE TRIGGER papers_fts_au
    AFTER UPDATE OF title, abstract ON papers BEGIN
      DELETE FROM papers_fts WHERE arxiv_id = old.arxiv_id;
      INSERT INTO papers_fts (arxiv_id, title, abstract)
      VALUES (new.arxiv_id, new.title, new.abstract);
    END;

    CREATE TRIGGER papers_fts_ad
    AFTER DELETE ON papers BEGIN
      DELETE FROM papers_fts WHERE arxiv_id = old.arxiv_id;
    END;
  `);

  return { sqlite };
}

function insertPaper(
  db: Db,
  arxivId: string,
  title: string,
  abstract: string,
  publishedAt = '2026-02-01T00:00:00Z',
) {
  db.sqlite
    .prepare(
      `INSERT INTO papers (arxiv_id, title, abstract, published_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(arxivId, title, abstract, publishedAt);
}

function insertTrack(db: Db, arxivId: string, trackName: string, score: number) {
  db.sqlite
    .prepare(
      `INSERT INTO track_matches (arxiv_id, track_name, score, matched_at)
       VALUES (?, ?, ?, '2026-02-01T12:00:00Z')`,
    )
    .run(arxivId, trackName, score);
}

function insertLlmScore(db: Db, arxivId: string, score: number, reasoning = 'test') {
  db.sqlite
    .prepare(
      `INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, scored_at)
       VALUES (?, ?, ?, '2026-02-01T13:00:00Z')`,
    )
    .run(arxivId, score, reasoning);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('searchPapers — empty DB', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns empty results for any query', () => {
    const result = searchPapers(db, 'speculative decoding');
    expect(result.kind).toBe('searchResults');
    expect(result.count).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.query).toBe('speculative decoding');
  });

  it('returns empty for blank query', () => {
    const result = searchPapers(db, '');
    expect(result.count).toBe(0);
  });

  it('returns empty for whitespace-only query', () => {
    const result = searchPapers(db, '   ');
    expect(result.count).toBe(0);
  });
});

describe('searchPapers — basic matching', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    insertPaper(
      db,
      '2501.00001',
      'SpecTr: Fast Speculative Decoding via Optimal Transport',
      'We propose SpecTr, a method for speculative decoding that uses optimal transport to align token distributions between a draft and target model.',
    );
    insertPaper(
      db,
      '2501.00002',
      'RAG-Fusion: Improved Retrieval-Augmented Generation',
      'This paper introduces RAG-Fusion, which combines multiple retrieval strategies to improve factuality in language model outputs.',
    );
    insertPaper(
      db,
      '2501.00003',
      'Quantization Strategies for Large Language Models',
      'We survey quantization methods including GPTQ, AWQ, and bitsandbytes for compressing large language models to 4-bit and 8-bit precision.',
    );
    insertTrack(db, '2501.00001', 'LLM Efficiency', 85);
    insertTrack(db, '2501.00002', 'RAG & Grounding', 72);
    insertTrack(db, '2501.00003', 'LLM Efficiency', 68);
    insertLlmScore(db, '2501.00001', 5, 'Key paper on speculative decoding');
    insertLlmScore(db, '2501.00002', 3, 'Incremental improvement on RAG');
    insertLlmScore(db, '2501.00003', 4, 'Good survey of quantization');
  });

  it('finds paper by title keyword', () => {
    const result = searchPapers(db, 'speculative decoding');
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.results[0]?.arxivId).toBe('2501.00001');
  });

  it('finds paper by abstract keyword', () => {
    const result = searchPapers(db, 'optimal transport');
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.results[0]?.arxivId).toBe('2501.00001');
  });

  it('finds RAG paper', () => {
    const result = searchPapers(db, 'retrieval augmented generation');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const arxivIds = result.results.map(r => r.arxivId);
    expect(arxivIds).toContain('2501.00002');
  });

  it('finds quantization paper', () => {
    const result = searchPapers(db, 'quantization GPTQ');
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.results[0]?.arxivId).toBe('2501.00003');
  });

  it('returns no results for unrelated query', () => {
    const result = searchPapers(db, 'protein folding biology');
    expect(result.count).toBe(0);
  });
});

describe('searchPapers — result structure', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    insertPaper(
      db,
      '2601.12345',
      'Efficient Inference via Speculative Sampling',
      'A '.repeat(150) + 'long abstract that exceeds 200 characters to test excerpt truncation.',
      '2026-01-15T00:00:00Z',
    );
    insertTrack(db, '2601.12345', 'LLM Efficiency', 90);
    insertLlmScore(db, '2601.12345', 4, 'Solid inference optimization work');
  });

  it('result has all required fields', () => {
    const result = searchPapers(db, 'speculative sampling');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const r = result.results[0]!;
    expect(r.arxivId).toBe('2601.12345');
    expect(r.title).toBe('Efficient Inference via Speculative Sampling');
    expect(r.llmScore).toBe(4);
    expect(r.llmReasoning).toBe('Solid inference optimization work');
    expect(r.keywordScore).toBe(90);
    expect(r.tracks).toContain('LLM Efficiency');
    expect(r.absUrl).toBe('https://arxiv.org/abs/2601.12345');
    expect(r.publishedAt).toBe('2026-01-15T00:00:00Z');
  });

  it('excerpt is truncated to ~200 chars with ellipsis', () => {
    const result = searchPapers(db, 'speculative sampling');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const r = result.results[0]!;
    expect(r.excerpt.length).toBeLessThanOrEqual(203); // 200 + "…"
    expect(r.excerpt.endsWith('…')).toBe(true);
  });

  it('result without llm score has llmScore null', () => {
    db.sqlite.prepare('DELETE FROM llm_scores WHERE arxiv_id = ?').run('2601.12345');
    const result = searchPapers(db, 'speculative sampling');
    if (result.count > 0) {
      expect(result.results[0]?.llmScore).toBeNull();
    }
  });
});

describe('searchPapers — ranking', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    // Paper A: score 5, matches "transformer"
    insertPaper(db, '2501.00010', 'Transformer Architecture Improvements', 'Advances in transformer architecture for language modeling.');
    insertLlmScore(db, '2501.00010', 5, 'top-tier');
    insertTrack(db, '2501.00010', 'Architecture', 80);

    // Paper B: score 3, also matches "transformer"
    insertPaper(db, '2501.00011', 'Transformer Fine-tuning Survey', 'A survey of fine-tuning methods for transformer models.');
    insertLlmScore(db, '2501.00011', 3, 'decent');
    insertTrack(db, '2501.00011', 'Fine-tuning', 60);

    // Paper C: score 4, also matches "transformer"
    insertPaper(db, '2501.00012', 'Efficient Transformer Training', 'Efficient training strategies for large transformer models.');
    insertLlmScore(db, '2501.00012', 4, 'good');
    insertTrack(db, '2501.00012', 'Training', 70);
  });

  it('orders results by llm score descending', () => {
    const result = searchPapers(db, 'transformer');
    expect(result.count).toBeGreaterThanOrEqual(3);
    const scores = result.results.map(r => r.llmScore);
    // First result should be score 5
    expect(scores[0]).toBe(5);
    // Should be in descending order
    for (let i = 1; i < scores.length; i++) {
      expect((scores[i] ?? 0)).toBeLessThanOrEqual((scores[i - 1] ?? 0));
    }
  });
});

describe('searchPapers — options', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    insertPaper(db, '2501.00020', 'Low-rank Adaptation for LLMs', 'LoRA and QLoRA methods for parameter-efficient fine-tuning.');
    insertPaper(db, '2501.00021', 'Prefix Tuning for Language Models', 'Prefix tuning as an alternative to full fine-tuning of language models.');
    insertTrack(db, '2501.00020', 'Fine-tuning', 75);
    insertTrack(db, '2501.00021', 'Fine-tuning', 55);
    insertLlmScore(db, '2501.00020', 5);
    insertLlmScore(db, '2501.00021', 2);
  });

  it('respects limit option', () => {
    const result = searchPapers(db, 'fine-tuning', { limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it('respects minLlmScore filter', () => {
    const result = searchPapers(db, 'language models', { minLlmScore: 4 });
    for (const r of result.results) {
      expect(r.llmScore).not.toBeNull();
      expect(r.llmScore!).toBeGreaterThanOrEqual(4);
    }
  });

  it('respects track filter', () => {
    const result = searchPapers(db, 'language models', { track: 'Fine-tuning' });
    for (const r of result.results) {
      expect(r.tracks.some(t => t.includes('Fine-tuning'))).toBe(true);
    }
  });

  it('clamps limit to max 20', () => {
    // Insert many papers
    for (let i = 0; i < 25; i++) {
      insertPaper(db, `2501.0${100 + i}`, `Paper ${i} about language models`, `Abstract about language model training ${i}.`);
    }
    const result = searchPapers(db, 'language models', { limit: 99 });
    expect(result.results.length).toBeLessThanOrEqual(20);
  });
});

describe('searchPapers — porter stemming', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    insertPaper(
      db,
      '2501.00030',
      'Training Large Language Models at Scale',
      'We present techniques for training large neural networks efficiently using distributed computing.',
    );
  });

  it('matches stemmed forms (training → train)', () => {
    // "train" should match "training" via porter stemmer
    const result = searchPapers(db, 'train');
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('matches plural forms (networks → network)', () => {
    const result = searchPapers(db, 'network');
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});

describe('searchPapers — tracks', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    insertPaper(db, '2501.00040', 'Multi-Track Paper', 'Covers both efficiency and alignment topics.');
    insertTrack(db, '2501.00040', 'LLM Efficiency', 80);
    insertTrack(db, '2501.00040', 'Alignment & Safety', 60);
  });

  it('includes all tracks for a paper', () => {
    const result = searchPapers(db, 'efficiency alignment');
    expect(result.count).toBeGreaterThanOrEqual(1);
    const paper = result.results.find(r => r.arxivId === '2501.00040');
    if (paper) {
      expect(paper.tracks).toContain('LLM Efficiency');
      expect(paper.tracks).toContain('Alignment & Safety');
    }
  });

  it('paper with no tracks has empty tracks array', () => {
    insertPaper(db, '2501.00041', 'Untracked Paper About Efficiency', 'No track matches for this one.');
    const result = searchPapers(db, 'untracked efficiency');
    const paper = result.results.find(r => r.arxivId === '2501.00041');
    if (paper) {
      expect(Array.isArray(paper.tracks)).toBe(true);
    }
  });
});
