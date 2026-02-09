import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { isoWeek, weekDateRange, selectWeeklyShortlist, selectWeeklyPaper, getRelatedPapers } from './select.js';
import type { Db } from '../db.js';

describe('isoWeek', () => {
  it('calculates ISO week for a typical date', () => {
    // Monday 2026-02-09 is in W07
    expect(isoWeek(new Date('2026-02-09T00:00:00Z'))).toBe('2026-W07');
  });

  it('handles year boundary - late December', () => {
    // Dec 31, 2025 is a Wednesday, still in 2026-W01
    expect(isoWeek(new Date('2025-12-31T00:00:00Z'))).toBe('2026-W01');
  });

  it('handles year boundary - early January', () => {
    // Jan 1, 2026 is a Thursday, in 2026-W01
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('handles start of week 1', () => {
    // Dec 29, 2025 is Monday of 2026-W01
    expect(isoWeek(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
  });

  it('handles end of year', () => {
    // Dec 28, 2025 is Sunday of 2025-W52
    expect(isoWeek(new Date('2025-12-28T00:00:00Z'))).toBe('2025-W52');
  });
});

describe('weekDateRange', () => {
  it('returns correct range for 2026-W07', () => {
    const range = weekDateRange('2026-W07');
    // W07 2026: Monday Feb 9 to Sunday Feb 15
    expect(range.start.toISOString()).toBe('2026-02-09T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-02-15T23:59:59.999Z');
  });

  it('returns correct range for 2026-W01', () => {
    const range = weekDateRange('2026-W01');
    // W01 2026 starts Monday Dec 29, 2025
    expect(range.start.toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-01-04T23:59:59.999Z');
  });

  it('throws on invalid format', () => {
    expect(() => weekDateRange('2026-07')).toThrow('Invalid ISO week format');
  });
});

describe('selectWeeklyShortlist', () => {
  let tmpDir: string;
  let db: Db;
  let metaDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-test-'));
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
    `);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertPaper(arxivId: string, title: string, metaPath: string) {
    db.sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, 
        published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
      VALUES (?, ?, 'Abstract text', '["Author One"]', '["cs.AI"]',
        '2026-02-09T00:00:00Z', '2026-02-09T00:00:00Z', '', '', ?, '2026-02-09T00:00:00Z')
    `).run(arxivId, title, metaPath);
  }

  function insertMatch(arxivId: string, trackName: string, score: number, matchedAt: string) {
    db.sqlite.prepare(`
      INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
      VALUES (?, ?, ?, '["keyword"]', ?)
    `).run(arxivId, trackName, score, matchedAt);
  }

  it('returns empty array when no papers matched this week', () => {
    const result = selectWeeklyShortlist(db, '2026-W07');
    expect(result).toEqual([]);
  });

  it('returns top 3 papers by score', () => {
    // Create meta files
    for (let i = 1; i <= 5; i++) {
      const metaPath = path.join(metaDir, `paper${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({ absUrl: `https://arxiv.org/abs/2602.0${i}` }));
      insertPaper(`2602.0${i}`, `Paper ${i}`, metaPath);
      insertMatch(`2602.0${i}`, 'Track A', i, '2026-02-10T12:00:00Z');
    }

    const result = selectWeeklyShortlist(db, '2026-W07');
    expect(result).toHaveLength(3);
    expect(result[0]!.arxivId).toBe('2602.05');
    expect(result[0]!.score).toBe(5);
    expect(result[0]!.rank).toBe(1);
    expect(result[1]!.arxivId).toBe('2602.04');
    expect(result[2]!.arxivId).toBe('2602.03');
  });

  it('deduplicates papers matched in multiple tracks', () => {
    const metaPath = path.join(metaDir, 'paper1.json');
    fs.writeFileSync(metaPath, JSON.stringify({ absUrl: 'https://arxiv.org/abs/2602.01' }));
    insertPaper('2602.01', 'Multi-track Paper', metaPath);
    
    // Same paper, two tracks, different scores
    insertMatch('2602.01', 'Track A', 3, '2026-02-10T12:00:00Z');
    insertMatch('2602.01', 'Track B', 5, '2026-02-10T12:00:00Z');

    const result = selectWeeklyShortlist(db, '2026-W07');
    expect(result).toHaveLength(1);
    expect(result[0]!.arxivId).toBe('2602.01');
    expect(result[0]!.score).toBe(5); // Max score
    expect(result[0]!.tracks).toContain('Track A');
    expect(result[0]!.tracks).toContain('Track B');
  });

  it('respects maxCandidates option', () => {
    for (let i = 1; i <= 5; i++) {
      const metaPath = path.join(metaDir, `paper${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({}));
      insertPaper(`2602.0${i}`, `Paper ${i}`, metaPath);
      insertMatch(`2602.0${i}`, 'Track A', i, '2026-02-10T12:00:00Z');
    }

    const result = selectWeeklyShortlist(db, '2026-W07', { maxCandidates: 2 });
    expect(result).toHaveLength(2);
  });

  it('excludes papers from other weeks', () => {
    const metaPath = path.join(metaDir, 'paper1.json');
    fs.writeFileSync(metaPath, JSON.stringify({}));
    insertPaper('2602.01', 'Wrong Week Paper', metaPath);
    insertMatch('2602.01', 'Track A', 5, '2026-02-01T12:00:00Z'); // W05, not W07

    const result = selectWeeklyShortlist(db, '2026-W07');
    expect(result).toEqual([]);
  });
});

describe('selectWeeklyPaper', () => {
  let tmpDir: string;
  let db: Db;
  let metaDir: string;
  let pickFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-pick-test-'));
    metaDir = path.join(tmpDir, 'papers');
    pickFile = path.join(tmpDir, 'pick.json');
    fs.mkdirSync(metaDir, { recursive: true });

    const sqlite = new Database(':memory:');
    db = { sqlite };

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
    `);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertPaper(arxivId: string, title: string, metaPath: string) {
    db.sqlite.prepare(`
      INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, 
        published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
      VALUES (?, ?, 'Abstract', '[]', '[]',
        '2026-02-09T00:00:00Z', '2026-02-09T00:00:00Z', '', '', ?, '2026-02-09T00:00:00Z')
    `).run(arxivId, title, metaPath);
  }

  function insertMatch(arxivId: string, trackName: string, score: number) {
    db.sqlite.prepare(`
      INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
      VALUES (?, ?, ?, '[]', '2026-02-10T12:00:00Z')
    `).run(arxivId, trackName, score);
  }

  it('returns null when no papers matched this week', () => {
    const result = selectWeeklyPaper(db, '2026-W07', pickFile);
    expect(result).toBeNull();
  });

  it('auto-selects highest-scored paper when no pick file', () => {
    for (let i = 1; i <= 3; i++) {
      const metaPath = path.join(metaDir, `p${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({}));
      insertPaper(`2602.0${i}`, `Paper ${i}`, metaPath);
      insertMatch(`2602.0${i}`, 'Track', i);
    }

    const result = selectWeeklyPaper(db, '2026-W07', null);
    expect(result?.arxivId).toBe('2602.03');
  });

  it('uses pick file when valid', () => {
    for (let i = 1; i <= 3; i++) {
      const metaPath = path.join(metaDir, `p${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({}));
      insertPaper(`2602.0${i}`, `Paper ${i}`, metaPath);
      insertMatch(`2602.0${i}`, 'Track', i);
    }

    fs.writeFileSync(pickFile, JSON.stringify({ arxivId: '2602.01' }));

    const result = selectWeeklyPaper(db, '2026-W07', pickFile);
    expect(result?.arxivId).toBe('2602.01');
    expect(result?.rank).toBe(1);
  });

  it('ignores pick file if arxivId not found in candidates', () => {
    for (let i = 1; i <= 2; i++) {
      const metaPath = path.join(metaDir, `p${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({}));
      insertPaper(`2602.0${i}`, `Paper ${i}`, metaPath);
      insertMatch(`2602.0${i}`, 'Track', i);
    }

    fs.writeFileSync(pickFile, JSON.stringify({ arxivId: '2602.99' })); // Not in candidates

    const result = selectWeeklyPaper(db, '2026-W07', pickFile);
    expect(result?.arxivId).toBe('2602.02'); // Auto-select highest
  });

  it('ignores malformed pick file', () => {
    const metaPath = path.join(metaDir, 'p1.json');
    fs.writeFileSync(metaPath, JSON.stringify({}));
    insertPaper('2602.01', 'Paper 1', metaPath);
    insertMatch('2602.01', 'Track', 5);

    fs.writeFileSync(pickFile, 'not valid json');

    const result = selectWeeklyPaper(db, '2026-W07', pickFile);
    expect(result?.arxivId).toBe('2602.01');
  });
});

describe('getRelatedPapers', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-related-test-'));
    const metaDir = path.join(tmpDir, 'papers');
    fs.mkdirSync(metaDir, { recursive: true });

    const sqlite = new Database(':memory:');
    db = { sqlite };

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
    `);

    // Insert 5 papers
    for (let i = 1; i <= 5; i++) {
      const metaPath = path.join(metaDir, `p${i}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({}));
      db.sqlite.prepare(`
        INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, 
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
        VALUES (?, ?, 'Abstract', '[]', '[]',
          '2026-02-09T00:00:00Z', '2026-02-09T00:00:00Z', '', '', ?, '2026-02-09T00:00:00Z')
      `).run(`2602.0${i}`, `Paper ${i}`, metaPath);
      db.sqlite.prepare(`
        INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
        VALUES (?, 'Track', ?, '[]', '2026-02-10T12:00:00Z')
      `).run(`2602.0${i}`, i);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes the selected paper', () => {
    const result = getRelatedPapers(db, '2026-W07', '2602.05');
    expect(result.map(r => r.arxivId)).not.toContain('2602.05');
    expect(result).toHaveLength(4);
  });

  it('respects maxRelated option', () => {
    const result = getRelatedPapers(db, '2026-W07', '2602.05', { maxRelated: 2 });
    expect(result).toHaveLength(2);
  });
});
