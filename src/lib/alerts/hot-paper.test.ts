/**
 * hot-paper.test.ts — Tests for hot paper alert detection + formatting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import type { Db } from '../db.js';
import { migrate } from '../db.js';
import {
  findNewHotPapers,
  recordHotAlerts,
  formatHotAlertMessage,
  formatHotAlertBatchHeader,
  processHotAlerts,
} from './hot-paper.js';

// ── Test DB helpers ───────────────────────────────────────────────────────────

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
    updatedAt?: string;
    pdfPath?: string;
    txtPath?: string;
    metaPath?: string;
  } = {}
) {
  const now = new Date().toISOString();
  db.sqlite.prepare(
    `INSERT OR REPLACE INTO papers
       (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
        published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
     VALUES (?, 'v1', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
  ).run(
    arxivId,
    opts.title ?? `Paper ${arxivId}`,
    opts.abstract ?? 'Abstract text.',
    JSON.stringify(opts.authors ?? ['Author One', 'Author Two']),
    opts.publishedAt ?? '2026-03-15T00:00:00Z',
    opts.updatedAt ?? '2026-03-15T00:00:00Z',
    opts.pdfPath ?? `/tmp/${arxivId}.pdf`,
    opts.txtPath ?? `/tmp/${arxivId}.txt`,
    opts.metaPath ?? `/tmp/${arxivId}.json`,
    now
  );
}

function seedTrackMatch(
  db: Db,
  arxivId: string,
  trackName: string,
  score: number,
  terms: string[] = [],
  matchedAgo = '1 hour ago'
) {
  // Use SQLite's datetime arithmetic for matched_at
  const matchedAt = matchedAgo === 'now'
    ? new Date().toISOString()
    : new Date(Date.now() - parseAge(matchedAgo)).toISOString();

  db.sqlite.prepare(
    `INSERT OR REPLACE INTO track_matches
       (arxiv_id, track_name, score, matched_terms_json, matched_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(arxivId, trackName, score, JSON.stringify(terms), matchedAt);
}

function parseAge(s: string): number {
  const parts = s.split(' ');
  const n = parts[0] ?? '0';
  const unit = parts[1] ?? '';
  const num = parseInt(n, 10);
  if (unit.startsWith('hour')) return num * 3600 * 1000;
  if (unit.startsWith('day')) return num * 86400 * 1000;
  if (unit.startsWith('minute')) return num * 60 * 1000;
  throw new Error(`Unknown unit: ${unit}`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('findNewHotPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    // Seed a handful of papers
    seedPaper(db, '2603.00001', { title: 'Agent Planning at Scale' });
    seedPaper(db, '2603.00002', { title: 'RAG with Graph Databases' });
    seedPaper(db, '2603.00003', { title: 'Tool Use in LLMs' });
    seedPaper(db, '2603.00004', { title: 'Transformer Pruning' });
  });

  it('returns papers scoring above threshold', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9, ['planning', 'scale', 'agent']);
    seedTrackMatch(db, '2603.00002', 'RAG', 6);

    const results = findNewHotPapers(db, { threshold: 8 });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00001');
    expect(results[0]!.score).toBe(9);
  });

  it('excludes papers already in hot_alerts', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    seedTrackMatch(db, '2603.00002', 'RAG', 8);

    // Mark the first as already alerted
    db.sqlite.prepare(
      `INSERT INTO hot_alerts (arxiv_id, track_name, score) VALUES (?, ?, ?)`
    ).run('2603.00001', 'Agents', 9);

    const results = findNewHotPapers(db, { threshold: 8 });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00002');
  });

  it('excludes papers matched outside the window', () => {
    // Matched 5 days ago — outside default 3-day window
    seedTrackMatch(db, '2603.00001', 'Agents', 9, [], '5 days ago');
    seedTrackMatch(db, '2603.00002', 'RAG', 9, [], '2 days ago');

    const results = findNewHotPapers(db, { threshold: 8, windowDays: 3 });
    expect(results).toHaveLength(1);
    expect(results[0]!.arxivId).toBe('2603.00002');
  });

  it('respects maxPerRun limit', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    seedTrackMatch(db, '2603.00002', 'RAG', 8);
    seedTrackMatch(db, '2603.00003', 'Tools', 10);

    const results = findNewHotPapers(db, { threshold: 8, maxPerRun: 2 });
    expect(results).toHaveLength(2);
    // Sorted by score DESC — should get the two highest
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  it('returns empty array when no papers qualify', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 5);
    const results = findNewHotPapers(db, { threshold: 8 });
    expect(results).toHaveLength(0);
  });

  it('includes matched terms in result', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9, ['planning', 'multi-agent', 'tool use']);
    const results = findNewHotPapers(db, { threshold: 8 });
    expect(results[0]!.matchedTerms).toContain('planning');
    expect(results[0]!.matchedTerms).toContain('multi-agent');
  });

  it('parses authors correctly', () => {
    seedPaper(db, '2603.00005', {
      title: 'Multiauthor Paper',
      authors: ['Zhang Wei', 'Li Ming', 'Wang Fang', 'Chen Xiao'],
    });
    seedTrackMatch(db, '2603.00005', 'Agents', 9);

    const results = findNewHotPapers(db, { threshold: 8 });
    const paper = results.find((p) => p.arxivId === '2603.00005')!;
    expect(paper.authors).toBe('Zhang Wei et al.');
  });

  it('handles single author correctly', () => {
    seedPaper(db, '2603.00006', { authors: ['Solo Researcher'] });
    seedTrackMatch(db, '2603.00006', 'Agents', 9);
    const results = findNewHotPapers(db, { threshold: 8 });
    const paper = results.find((p) => p.arxivId === '2603.00006')!;
    expect(paper.authors).toBe('Solo Researcher');
  });

  it('handles malformed authors_json gracefully', () => {
    db.sqlite.prepare(
      `INSERT OR REPLACE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, ?, ?, '[]', ?, ?, ?, ?, ?, datetime('now'))`
    ).run('2603.00007', 'Bad Authors Paper', 'Abstract', 'not_json',
      '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z', '/tmp/a.pdf', '/tmp/a.txt', '/tmp/a.json');
    seedTrackMatch(db, '2603.00007', 'Agents', 9);
    // Should not throw
    expect(() => findNewHotPapers(db, { threshold: 8 })).not.toThrow();
  });

  it('builds correct arxiv abs URL', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    const results = findNewHotPapers(db, { threshold: 8 });
    expect(results[0]!.absUrl).toBe('https://arxiv.org/abs/2603.00001');
  });
});

// ── recordHotAlerts tests ─────────────────────────────────────────────────────

describe('recordHotAlerts', () => {
  let db: Db;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    seedPaper(db, '2603.00001');
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
  });

  it('records alerts in hot_alerts table', () => {
    recordHotAlerts(db, [{ arxivId: '2603.00001', trackName: 'Agents', score: 9 }]);

    const row = db.sqlite.prepare(
      'SELECT * FROM hot_alerts WHERE arxiv_id=? AND track_name=?'
    ).get('2603.00001', 'Agents') as any;

    expect(row).toBeTruthy();
    expect(row.score).toBe(9);
    expect(row.alerted_at).toBeTruthy();
  });

  it('is idempotent — second record does not throw', () => {
    const input = [{ arxivId: '2603.00001', trackName: 'Agents', score: 9 }];
    expect(() => {
      recordHotAlerts(db, input);
      recordHotAlerts(db, input);
    }).not.toThrow();
  });

  it('records multiple papers in one call', () => {
    seedPaper(db, '2603.00002');
    seedTrackMatch(db, '2603.00002', 'RAG', 8);

    recordHotAlerts(db, [
      { arxivId: '2603.00001', trackName: 'Agents', score: 9 },
      { arxivId: '2603.00002', trackName: 'RAG', score: 8 },
    ]);

    const count = (db.sqlite.prepare('SELECT COUNT(*) as n FROM hot_alerts').get() as any).n;
    expect(count).toBe(2);
  });
});

// ── formatHotAlertMessage tests ───────────────────────────────────────────────

describe('formatHotAlertMessage', () => {
  const basePaper = {
    arxivId: '2603.12345',
    trackName: 'Agent Evaluation & Reliability',
    score: 9,
    title: 'Self-Calibrating Multi-Agent Systems for Complex Reasoning',
    authors: 'Zhang Wei et al.',
    abstract: 'We propose a self-calibrating framework for multi-agent systems that improves reliability through automated trust score assignment between agents during collaborative reasoning tasks.',
    publishedAt: '2026-03-15T00:00:00Z',
    absUrl: 'https://arxiv.org/abs/2603.12345',
    matchedTerms: ['multi-agent', 'calibration', 'planning', 'tool use', 'reliability'],
  };

  it('includes the track name', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('Agent Evaluation & Reliability');
  });

  it('includes the score', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('9');
  });

  it('includes the paper title', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('Self-Calibrating Multi-Agent Systems');
  });

  it('includes authors', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('Zhang Wei et al.');
  });

  it('includes publication date (date part only)', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('2026-03-15');
  });

  it('includes arxiv URL', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('https://arxiv.org/abs/2603.12345');
  });

  it('includes matched terms (up to 6)', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg).toContain('multi-agent');
    expect(msg).toContain('calibration');
  });

  it('truncates very long abstracts to ≤280 chars', () => {
    const longAbstract = 'A'.repeat(400);
    const msg = formatHotAlertMessage({ ...basePaper, abstract: longAbstract });
    // The excerpt should not have 400 'A's
    const excerptMatch = msg.match(/A{10,}/);
    if (excerptMatch) {
      expect(excerptMatch[0].length).toBeLessThanOrEqual(280);
    }
  });

  it('does not include matched terms section when terms is empty', () => {
    const msg = formatHotAlertMessage({ ...basePaper, matchedTerms: [] });
    expect(msg).not.toContain('Matched:');
  });

  it('starts with 🔥 emoji', () => {
    const msg = formatHotAlertMessage(basePaper);
    expect(msg.trimStart()).toMatch(/^🔥/);
  });
});

// ── formatHotAlertBatchHeader tests ──────────────────────────────────────────

describe('formatHotAlertBatchHeader', () => {
  const makePaper = (id: string, track: string): any => ({
    arxivId: id,
    trackName: track,
    score: 9,
    title: 'Test',
    authors: 'Author',
    abstract: 'Abstract',
    publishedAt: '2026-03-15T00:00:00Z',
    absUrl: `https://arxiv.org/abs/${id}`,
    matchedTerms: [],
  });

  it('returns empty string for 0 papers', () => {
    expect(formatHotAlertBatchHeader([])).toBe('');
  });

  it('returns empty string for 1 paper (no header needed)', () => {
    expect(formatHotAlertBatchHeader([makePaper('x', 'Agents')])).toBe('');
  });

  it('returns a header for 2+ papers', () => {
    const header = formatHotAlertBatchHeader([
      makePaper('a', 'Agents'),
      makePaper('b', 'RAG'),
    ]);
    expect(header).toContain('2 high-scoring papers');
  });

  it('groups by track in header', () => {
    const header = formatHotAlertBatchHeader([
      makePaper('a', 'Agents'),
      makePaper('b', 'Agents'),
      makePaper('c', 'RAG'),
    ]);
    expect(header).toContain('2 in Agents');
    expect(header).toContain('1 in RAG');
  });
});

// ── processHotAlerts integration tests ───────────────────────────────────────

describe('processHotAlerts', () => {
  let db: Db;

  beforeEach(() => {
    db = openTestDb();
    migrate(db);
    seedPaper(db, '2603.00001', { title: 'Hot Paper Alpha', abstract: 'Alpha abstract.' });
    seedPaper(db, '2603.00002', { title: 'Hot Paper Beta', abstract: 'Beta abstract.' });
    seedPaper(db, '2603.00003', { title: 'Cold Paper', abstract: 'Cold abstract.' });
  });

  it('returns empty result when no hot papers', () => {
    seedTrackMatch(db, '2603.00003', 'Agents', 5);
    const result = processHotAlerts(db, { threshold: 8 });
    expect(result.totalFound).toBe(0);
    expect(result.messages).toHaveLength(0);
    expect(result.papers).toHaveLength(0);
  });

  it('returns paper messages for hot papers', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9, ['planning']);
    const result = processHotAlerts(db, { threshold: 8 });
    expect(result.totalFound).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toContain('Hot Paper Alpha');
  });

  it('records alerts in DB by default', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    processHotAlerts(db, { threshold: 8 });

    const row = db.sqlite.prepare('SELECT * FROM hot_alerts WHERE arxiv_id=?').get('2603.00001');
    expect(row).toBeTruthy();
  });

  it('does not record alerts in dryRun mode', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    processHotAlerts(db, { threshold: 8, dryRun: true });

    const row = db.sqlite.prepare('SELECT * FROM hot_alerts WHERE arxiv_id=?').get('2603.00001');
    expect(row).toBeUndefined(); // better-sqlite3 returns undefined (not null) for missing rows
  });

  it('adds a batch header when multiple hot papers found', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9, ['planning']);
    seedTrackMatch(db, '2603.00002', 'RAG', 8, ['retrieval']);

    const result = processHotAlerts(db, { threshold: 8 });
    expect(result.totalFound).toBe(2);
    // 1 batch header + 2 paper messages
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toContain('2 high-scoring papers');
  });

  it('does not send already-alerted papers again', () => {
    seedTrackMatch(db, '2603.00001', 'Agents', 9);
    seedTrackMatch(db, '2603.00002', 'RAG', 8);

    // First run — alerts both
    const first = processHotAlerts(db, { threshold: 8 });
    expect(first.totalFound).toBe(2);

    // Second run — nothing new
    const second = processHotAlerts(db, { threshold: 8 });
    expect(second.totalFound).toBe(0);
  });
});
