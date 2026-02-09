import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import {
  lookupPaper,
  detectQueryType,
  extractTokens,
  stripVersion,
  parseDigestDate,
} from './lookup.js';
import type { Db } from '../db.js';

describe('detectQueryType', () => {
  it('detects arxiv ID', () => {
    expect(detectQueryType('2602.06038')).toBe('arxiv-id');
    expect(detectQueryType('2602.06038v1')).toBe('arxiv-id');
    expect(detectQueryType('2501.12345v2')).toBe('arxiv-id');
  });

  it('detects digest reference', () => {
    expect(detectQueryType('#2 from today')).toBe('digest-ref');
    expect(detectQueryType('#1 from yesterday')).toBe('digest-ref');
    expect(detectQueryType('#3 from 2026-02-08')).toBe('digest-ref');
    expect(detectQueryType('paper #2 from today')).toBe('digest-ref');
    expect(detectQueryType('#1')).toBe('digest-ref');
  });

  it('detects title search', () => {
    expect(detectQueryType('CommCP paper')).toBe('title-search');
    expect(detectQueryType('conformal prediction')).toBe('title-search');
    expect(detectQueryType('multi-agent coordination')).toBe('title-search');
    expect(detectQueryType('the LLM one')).toBe('title-search');
  });
});

describe('extractTokens', () => {
  it('extracts meaningful tokens', () => {
    expect(extractTokens('CommCP paper')).toEqual(['commcp']);
    expect(extractTokens('conformal prediction')).toEqual(['conformal', 'prediction']);
    expect(extractTokens('multi-agent coordination')).toEqual(['multi', 'agent', 'coordination']);
  });

  it('filters out stopwords', () => {
    expect(extractTokens('the paper about LLMs')).toEqual(['llms']);
    expect(extractTokens('a study on agents')).toEqual(['study', 'agents']);
    expect(extractTokens('that one with transformers')).toEqual(['transformers']);
  });

  it('filters out short tokens', () => {
    expect(extractTokens('AI ML DL')).toEqual(['ai', 'ml', 'dl']);
    expect(extractTokens('a b c test')).toEqual(['test']);
  });

  it('handles empty query', () => {
    expect(extractTokens('')).toEqual([]);
    expect(extractTokens('the a an')).toEqual([]);
  });
});

describe('stripVersion', () => {
  it('strips version suffix', () => {
    expect(stripVersion('2602.06038v1')).toBe('2602.06038');
    expect(stripVersion('2602.06038v12')).toBe('2602.06038');
  });

  it('leaves ID without version unchanged', () => {
    expect(stripVersion('2602.06038')).toBe('2602.06038');
  });
});

describe('parseDigestDate', () => {
  const now = new Date('2026-02-09T12:00:00Z');

  it('parses "today"', () => {
    expect(parseDigestDate('today', now)).toBe('2026-02-09');
    expect(parseDigestDate('TODAY', now)).toBe('2026-02-09');
  });

  it('parses "yesterday"', () => {
    expect(parseDigestDate('yesterday', now)).toBe('2026-02-08');
    expect(parseDigestDate('YESTERDAY', now)).toBe('2026-02-08');
  });

  it('parses explicit date', () => {
    expect(parseDigestDate('2026-02-01', now)).toBe('2026-02-01');
  });

  it('defaults undefined to today', () => {
    expect(parseDigestDate(undefined, now)).toBe('2026-02-09');
  });
});

describe('lookupPaper', () => {
  let tmpDir: string;
  let db: Db;
  let metaDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-lookup-'));
    metaDir = path.join(tmpDir, 'papers');
    fs.mkdirSync(metaDir, { recursive: true });

    const sqlite = new Database(':memory:');
    db = { sqlite };

    // Create tables
    sqlite.exec(`
      CREATE TABLE papers (
        arxiv_id TEXT PRIMARY KEY,
        latest_version TEXT,
        title TEXT NOT NULL,
        abstract TEXT NOT NULL,
        authors_json TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        txt_path TEXT NOT NULL,
        meta_path TEXT NOT NULL,
        sha256_pdf TEXT,
        ingested_at TEXT NOT NULL
      );

      CREATE TABLE track_matches (
        arxiv_id TEXT NOT NULL,
        track_name TEXT NOT NULL,
        score INTEGER NOT NULL,
        matched_terms_json TEXT NOT NULL,
        matched_at TEXT NOT NULL,
        PRIMARY KEY (arxiv_id, track_name)
      );

      CREATE TABLE sent_digests (
        digest_date TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        header_text TEXT NOT NULL,
        tracks_json TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertPaper(arxivId: string, title: string, abstract = 'Test abstract') {
    const metaPath = path.join(metaDir, `${arxivId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      absUrl: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
    }));

    db.sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json,
        published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
      VALUES (?, ?, ?, '["Author One", "Author Two"]', '["cs.AI"]',
        '2026-02-09T00:00:00Z', '2026-02-09T00:00:00Z',
        '/path/to/paper.pdf', '/path/to/paper.txt', ?, '2026-02-09T00:00:00Z')
    `).run(arxivId, title, abstract, metaPath);
  }

  function insertMatch(arxivId: string, trackName: string, score: number, matchedAt = '2026-02-09T12:00:00Z') {
    db.sqlite.prepare(`
      INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
      VALUES (?, ?, ?, '["keyword"]', ?)
    `).run(arxivId, trackName, score, matchedAt);
  }

  describe('arxiv ID lookup', () => {
    it('finds paper by exact arxiv ID', () => {
      insertPaper('2602.06038', 'CommCP: Conformal Prediction for Multi-Agent Systems');
      insertMatch('2602.06038', 'AI Safety', 5);

      const result = lookupPaper(db, '2602.06038');
      expect(result.status).toBe('found');
      expect(result.method).toBe('arxiv-id');
      expect(result.paper?.arxivId).toBe('2602.06038');
      expect(result.paper?.title).toBe('CommCP: Conformal Prediction for Multi-Agent Systems');
      expect(result.paper?.score).toBe(5);
      expect(result.paper?.tracks).toContain('AI Safety');
    });

    it('strips version suffix and finds paper', () => {
      insertPaper('2602.06038', 'CommCP Paper');
      insertMatch('2602.06038', 'Track A', 3);

      const result = lookupPaper(db, '2602.06038v1');
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.06038');
    });

    it('returns not-found for missing arxiv ID', () => {
      const result = lookupPaper(db, '9999.99999');
      expect(result.status).toBe('not-found');
      expect(result.method).toBe('arxiv-id');
      expect(result.query).toBe('9999.99999');
    });
  });

  describe('fuzzy title search', () => {
    it('finds single match', () => {
      insertPaper('2602.00001', 'Conformal Prediction for Deep Learning');
      insertMatch('2602.00001', 'Track A', 4);

      const result = lookupPaper(db, 'conformal prediction');
      expect(result.status).toBe('found');
      expect(result.method).toBe('title-search');
      expect(result.paper?.arxivId).toBe('2602.00001');
    });

    it('returns ambiguous for multiple matches', () => {
      insertPaper('2602.00001', 'Multi-Agent Coordination in Games');
      insertPaper('2602.00002', 'Multi-Agent Learning Systems');
      insertMatch('2602.00001', 'Track A', 5);
      insertMatch('2602.00002', 'Track A', 3);

      const result = lookupPaper(db, 'multi-agent');
      expect(result.status).toBe('ambiguous');
      expect(result.method).toBe('title-search');
      expect(result.candidates).toHaveLength(2);
      // Should be sorted by score DESC
      expect(result.candidates![0]!.arxivId).toBe('2602.00001');
      expect(result.candidates![0]!.score).toBe(5);
    });

    it('returns not-found for no match', () => {
      insertPaper('2602.00001', 'Something Completely Different');

      const result = lookupPaper(db, 'quantum computing');
      expect(result.status).toBe('not-found');
      expect(result.method).toBe('title-search');
    });

    it('filters stopwords correctly', () => {
      insertPaper('2602.00001', 'The Future of LLM Agents');
      insertMatch('2602.00001', 'Track A', 4);

      // Should match even with stopwords in query
      const result = lookupPaper(db, 'the paper about LLM agents');
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.00001');
    });

    it('returns not-found when query is all stopwords', () => {
      insertPaper('2602.00001', 'Test Paper');

      const result = lookupPaper(db, 'the a an');
      expect(result.status).toBe('not-found');
    });
  });

  describe('digest reference lookup', () => {
    it('finds paper #1 from specific date', () => {
      insertPaper('2602.00001', 'Paper A');
      insertPaper('2602.00002', 'Paper B');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-08T12:00:00Z');
      insertMatch('2602.00002', 'Track A', 3, '2026-02-08T12:00:00Z');

      const result = lookupPaper(db, '#1 from 2026-02-08');
      expect(result.status).toBe('found');
      expect(result.method).toBe('digest-ref');
      expect(result.paper?.arxivId).toBe('2602.00001'); // Highest score
    });

    it('finds paper #2 from specific date', () => {
      insertPaper('2602.00001', 'Paper A');
      insertPaper('2602.00002', 'Paper B');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-08T12:00:00Z');
      insertMatch('2602.00002', 'Track A', 3, '2026-02-08T12:00:00Z');

      const result = lookupPaper(db, '#2 from 2026-02-08');
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.00002'); // Second highest
    });

    it('handles "today" reference', () => {
      insertPaper('2602.00001', 'Paper Today');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-09T12:00:00Z');

      const now = new Date('2026-02-09T15:00:00Z');
      const result = lookupPaper(db, '#1 from today', now);
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.00001');
    });

    it('handles "yesterday" reference', () => {
      insertPaper('2602.00001', 'Paper Yesterday');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-08T12:00:00Z');

      const now = new Date('2026-02-09T15:00:00Z');
      const result = lookupPaper(db, '#1 from yesterday', now);
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.00001');
    });

    it('returns not-found for position out of range', () => {
      insertPaper('2602.00001', 'Paper A');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-08T12:00:00Z');

      const result = lookupPaper(db, '#5 from 2026-02-08');
      expect(result.status).toBe('not-found');
      expect(result.method).toBe('digest-ref');
    });

    it('returns not-found for date with no papers', () => {
      const result = lookupPaper(db, '#1 from 2020-01-01');
      expect(result.status).toBe('not-found');
      expect(result.method).toBe('digest-ref');
    });

    it('defaults to today when no date specified', () => {
      insertPaper('2602.00001', 'Paper Today');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-09T12:00:00Z');

      const now = new Date('2026-02-09T15:00:00Z');
      const result = lookupPaper(db, '#1', now);
      expect(result.status).toBe('found');
      expect(result.paper?.arxivId).toBe('2602.00001');
    });
  });

  describe('auto-detection', () => {
    it('detects arxiv ID format', () => {
      insertPaper('2602.06038', 'Test Paper');

      const result = lookupPaper(db, '2602.06038');
      expect(result.method).toBe('arxiv-id');
    });

    it('detects digest reference format', () => {
      insertPaper('2602.00001', 'Test Paper');
      insertMatch('2602.00001', 'Track A', 5, '2026-02-09T12:00:00Z');

      const result = lookupPaper(db, '#1 from 2026-02-09');
      expect(result.method).toBe('digest-ref');
    });

    it('defaults to title search', () => {
      insertPaper('2602.00001', 'CommCP Paper');

      const result = lookupPaper(db, 'CommCP');
      expect(result.method).toBe('title-search');
    });
  });
});
