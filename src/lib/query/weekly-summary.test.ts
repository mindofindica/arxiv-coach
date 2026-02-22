import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { getWeeklySummary } from './weekly-summary.js';
import type { Db } from '../db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new Database(':memory:');
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

    CREATE TABLE llm_scores (
      arxiv_id TEXT PRIMARY KEY,
      relevance_score INTEGER NOT NULL CHECK (relevance_score BETWEEN 1 AND 5),
      reasoning TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT 'sonnet',
      scored_at TEXT NOT NULL,
      FOREIGN KEY (arxiv_id) REFERENCES papers(arxiv_id) ON DELETE CASCADE
    );

    CREATE TABLE sent_weekly_digests (
      week_iso TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      arxiv_id TEXT NOT NULL,
      sections_json TEXT NOT NULL
    );
  `);
  return { sqlite };
}

function insertPaper(db: Db, arxivId: string, title: string, metaPath: string) {
  db.sqlite.prepare(`
    INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json,
      published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
    VALUES (?, ?, 'Abstract', '[]', '[]',
      '2026-02-16T00:00:00Z', '2026-02-16T00:00:00Z', '', '', ?, '2026-02-16T00:00:00Z')
  `).run(arxivId, title, metaPath);
}

function insertMatch(db: Db, arxivId: string, trackName: string, score: number, matchedAt = '2026-02-17T12:00:00Z') {
  db.sqlite.prepare(`
    INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
    VALUES (?, ?, ?, '[]', ?)
  `).run(arxivId, trackName, score, matchedAt);
}

function insertLlmScore(db: Db, arxivId: string, relevanceScore: number) {
  db.sqlite.prepare(`
    INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, model, scored_at)
    VALUES (?, ?, 'test reasoning', 'sonnet', '2026-02-17T13:00:00Z')
  `).run(arxivId, relevanceScore);
}

function insertSentWeekly(db: Db, weekIso: string, arxivId: string) {
  db.sqlite.prepare(`
    INSERT INTO sent_weekly_digests (week_iso, kind, sent_at, arxiv_id, sections_json)
    VALUES (?, 'weekly', '2026-02-22T09:00:00Z', ?, '[]')
  `).run(weekIso, arxivId);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 2026-W08: Mon Feb 16 → Sun Feb 22
const WEEK = '2026-W08';

describe('getWeeklySummary — empty week', () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsum-test-'));
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zero totalPapers when nothing matched', () => {
    const summary = getWeeklySummary(db, WEEK);
    expect(summary.kind).toBe('weeklySummary');
    expect(summary.weekIso).toBe(WEEK);
    expect(summary.totalPapers).toBe(0);
    expect(summary.trackStats).toHaveLength(0);
    expect(summary.topPapers).toHaveLength(0);
    expect(summary.deepDive.sent).toBe(false);
  });

  it('sets correct date range for 2026-W08', () => {
    const summary = getWeeklySummary(db, WEEK);
    expect(summary.dateRange.start).toBe('2026-02-16');
    expect(summary.dateRange.end).toBe('2026-02-22');
  });

  it('excludes papers matched in other weeks', () => {
    // Paper matched in 2026-W07 (Feb 9-15)
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({ absUrl: 'https://arxiv.org/abs/2602.01' }));
    insertPaper(db, '2602.01', 'Old Paper', meta);
    insertMatch(db, '2602.01', 'Track A', 5, '2026-02-13T12:00:00Z'); // W07

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.totalPapers).toBe(0);
  });
});

describe('getWeeklySummary — track breakdown', () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsum-track-test-'));
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts unique papers per track correctly', () => {
    const meta1 = path.join(tmpDir, 'p1.json');
    const meta2 = path.join(tmpDir, 'p2.json');
    fs.writeFileSync(meta1, JSON.stringify({}));
    fs.writeFileSync(meta2, JSON.stringify({}));

    insertPaper(db, '2602.01', 'Paper 1', meta1);
    insertPaper(db, '2602.02', 'Paper 2', meta2);

    // Track A: 2 papers
    insertMatch(db, '2602.01', 'Track A', 3);
    insertMatch(db, '2602.02', 'Track A', 5);
    // Track B: 1 paper (same as Track A's paper 1)
    insertMatch(db, '2602.01', 'Track B', 2);

    const summary = getWeeklySummary(db, WEEK);

    expect(summary.totalPapers).toBe(2); // 2 unique papers total
    expect(summary.trackStats).toHaveLength(2);

    const trackA = summary.trackStats.find(t => t.trackName === 'Track A')!;
    expect(trackA.count).toBe(2);
    expect(trackA.topKeywordScore).toBe(5);

    const trackB = summary.trackStats.find(t => t.trackName === 'Track B')!;
    expect(trackB.count).toBe(1);
    expect(trackB.topKeywordScore).toBe(2);
  });

  it('includes topLlmScore when papers have LLM scores', () => {
    const meta1 = path.join(tmpDir, 'p1.json');
    const meta2 = path.join(tmpDir, 'p2.json');
    fs.writeFileSync(meta1, JSON.stringify({}));
    fs.writeFileSync(meta2, JSON.stringify({}));

    insertPaper(db, '2602.01', 'Paper 1', meta1);
    insertPaper(db, '2602.02', 'Paper 2', meta2);
    insertMatch(db, '2602.01', 'Track A', 3);
    insertMatch(db, '2602.02', 'Track A', 5);
    insertLlmScore(db, '2602.01', 3);
    insertLlmScore(db, '2602.02', 5);

    const summary = getWeeklySummary(db, WEEK);
    const trackA = summary.trackStats.find(t => t.trackName === 'Track A')!;
    expect(trackA.topLlmScore).toBe(5);
  });

  it('sets topLlmScore to null when no LLM scores exist', () => {
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({}));
    insertPaper(db, '2602.01', 'Paper 1', meta);
    insertMatch(db, '2602.01', 'Track A', 4);

    const summary = getWeeklySummary(db, WEEK);
    const trackA = summary.trackStats.find(t => t.trackName === 'Track A')!;
    expect(trackA.topLlmScore).toBeNull();
  });
});

describe('getWeeklySummary — top papers', () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsum-top-test-'));
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ranks LLM-scored papers above keyword-only papers', () => {
    const metas = [1, 2, 3].map(i => {
      const p = path.join(tmpDir, `p${i}.json`);
      fs.writeFileSync(p, JSON.stringify({ absUrl: `https://arxiv.org/abs/2602.0${i}` }));
      return p;
    });

    insertPaper(db, '2602.01', 'Keyword Only Paper', metas[0]!);
    insertPaper(db, '2602.02', 'LLM Score 3', metas[1]!);
    insertPaper(db, '2602.03', 'LLM Score 5', metas[2]!);

    // High keyword score but no LLM score
    insertMatch(db, '2602.01', 'Track A', 100);
    // Lower keyword scores but LLM-scored
    insertMatch(db, '2602.02', 'Track A', 2);
    insertLlmScore(db, '2602.02', 3);
    insertMatch(db, '2602.03', 'Track A', 1);
    insertLlmScore(db, '2602.03', 5);

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.topPapers[0]!.arxivId).toBe('2602.03'); // LLM:5 first
    expect(summary.topPapers[1]!.arxivId).toBe('2602.02'); // LLM:3 second
    expect(summary.topPapers[2]!.arxivId).toBe('2602.01'); // keyword-only last
  });

  it('sorts keyword-only papers by keyword score when no LLM scores', () => {
    for (let i = 1; i <= 4; i++) {
      const meta = path.join(tmpDir, `p${i}.json`);
      fs.writeFileSync(meta, JSON.stringify({}));
      insertPaper(db, `2602.0${i}`, `Paper ${i}`, meta);
      insertMatch(db, `2602.0${i}`, 'Track A', i * 10); // scores: 10, 20, 30, 40
    }

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.topPapers[0]!.arxivId).toBe('2602.04'); // score 40
    expect(summary.topPapers[1]!.arxivId).toBe('2602.03'); // score 30
  });

  it('respects maxTopPapers option', () => {
    for (let i = 1; i <= 10; i++) {
      const meta = path.join(tmpDir, `p${i}.json`);
      fs.writeFileSync(meta, JSON.stringify({}));
      insertPaper(db, `2602.${String(i).padStart(2, '0')}`, `Paper ${i}`, meta);
      insertMatch(db, `2602.${String(i).padStart(2, '0')}`, 'Track A', i);
    }

    const summary = getWeeklySummary(db, WEEK, { maxTopPapers: 3 });
    expect(summary.topPapers).toHaveLength(3);
  });

  it('resolves absUrl from meta file', () => {
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({ absUrl: 'https://arxiv.org/abs/2602.01' }));
    insertPaper(db, '2602.01', 'Paper With URL', meta);
    insertMatch(db, '2602.01', 'Track A', 5);

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.topPapers[0]!.absUrl).toBe('https://arxiv.org/abs/2602.01');
  });

  it('sets absUrl to null when meta file is missing', () => {
    // metaPath points to non-existent file
    insertPaper(db, '2602.01', 'Paper No Meta', '/nonexistent/path.json');
    insertMatch(db, '2602.01', 'Track A', 5);

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.topPapers[0]!.absUrl).toBeNull();
  });

  it('aggregates tracks for multi-track papers', () => {
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({}));
    insertPaper(db, '2602.01', 'Multi-track Paper', meta);
    insertMatch(db, '2602.01', 'Track A', 3);
    insertMatch(db, '2602.01', 'Track B', 5);

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.topPapers[0]!.tracks).toContain('Track A');
    expect(summary.topPapers[0]!.tracks).toContain('Track B');
    expect(summary.topPapers[0]!.keywordScore).toBe(5); // max keyword score
  });
});

describe('getWeeklySummary — deep dive status', () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    db = makeDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsum-dd-test-'));
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('shows sent=false when no deep dive sent this week', () => {
    const summary = getWeeklySummary(db, WEEK);
    expect(summary.deepDive.sent).toBe(false);
    expect(summary.deepDive.arxivId).toBeNull();
    expect(summary.deepDive.title).toBeNull();
  });

  it('shows sent=true with arxivId and title when deep dive was sent', () => {
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({}));
    insertPaper(db, '2602.01', 'The Deep Dive Paper', meta);
    insertSentWeekly(db, WEEK, '2602.01');

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.deepDive.sent).toBe(true);
    expect(summary.deepDive.arxivId).toBe('2602.01');
    expect(summary.deepDive.title).toBe('The Deep Dive Paper');
  });

  it('sets title to null if deep dive paper not in papers table', () => {
    // Insert sent record without corresponding paper
    insertSentWeekly(db, WEEK, 'ghost-paper');

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.deepDive.sent).toBe(true);
    expect(summary.deepDive.arxivId).toBe('ghost-paper');
    expect(summary.deepDive.title).toBeNull();
  });

  it('does not show a different week\'s deep dive', () => {
    const meta = path.join(tmpDir, 'p1.json');
    fs.writeFileSync(meta, JSON.stringify({}));
    insertPaper(db, '2602.01', 'Last Week Paper', meta);
    insertSentWeekly(db, '2026-W07', '2602.01'); // Different week

    const summary = getWeeklySummary(db, WEEK);
    expect(summary.deepDive.sent).toBe(false);
  });
});
