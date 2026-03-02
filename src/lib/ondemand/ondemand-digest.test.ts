/**
 * Tests for on-demand digest — fetchOnDemandPapers, renderOnDemandReply, runOnDemandDigest.
 *
 * Uses an in-memory SQLite DB to avoid touching real data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { fetchOnDemandPapers, renderOnDemandReply, runOnDemandDigest } from './ondemand-digest.js';
import type { Db } from '../db.js';

// ── Minimal in-memory DB setup ────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new Database(':memory:');

  // Minimal schema for the tables we query
  sqlite.exec(`
    CREATE TABLE papers (
      arxiv_id   TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      abstract   TEXT NOT NULL DEFAULT '',
      updated_at TEXT,
      meta_path  TEXT NOT NULL DEFAULT '',
      ingested_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE track_matches (
      arxiv_id           TEXT NOT NULL,
      track_name         TEXT NOT NULL,
      score              REAL NOT NULL DEFAULT 0,
      matched_terms_json TEXT NOT NULL DEFAULT '[]',
      matched_at         TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (arxiv_id, track_name)
    );

    CREATE TABLE llm_scores (
      arxiv_id        TEXT PRIMARY KEY,
      relevance_score INTEGER
    );

    CREATE TABLE digest_papers (
      arxiv_id    TEXT NOT NULL,
      digest_date TEXT NOT NULL
    );
  `);

  return { sqlite } as Db;
}

function insertPaper(
  db: Db,
  id: string,
  title: string,
  abstract = 'Test abstract.',
  track = 'LLM',
  score = 5.0,
  llmScore: number | null = 4,
): void {
  db.sqlite
    .prepare(`INSERT OR IGNORE INTO papers (arxiv_id, title, abstract) VALUES (?,?,?)`)
    .run(id, title, abstract);

  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_matches (arxiv_id, track_name, score, matched_terms_json)
       VALUES (?,?,?,?)`,
    )
    .run(id, track, score, JSON.stringify(['transformer', 'attention']));

  if (llmScore !== null) {
    db.sqlite
      .prepare(`INSERT OR IGNORE INTO llm_scores (arxiv_id, relevance_score) VALUES (?,?)`)
      .run(id, llmScore);
  }
}

function markSent(db: Db, id: string, daysAgo = 0): void {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  db.sqlite
    .prepare(`INSERT INTO digest_papers (arxiv_id, digest_date) VALUES (?,?)`)
    .run(id, date.toISOString().split('T')[0]);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('fetchOnDemandPapers', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.sqlite.close();
  });

  it('returns an empty array when no papers exist', () => {
    const result = fetchOnDemandPapers(db);
    expect(result).toEqual([]);
  });

  it('returns papers from the DB', () => {
    insertPaper(db, '2401.00001', 'Paper A');
    const result = fetchOnDemandPapers(db);
    expect(result).toHaveLength(1);
    expect(result[0]!.arxivId).toBe('2401.00001');
    expect(result[0]!.title).toBe('Paper A');
  });

  it('includes papers already sent when respectDedup=false (default)', () => {
    insertPaper(db, '2401.00001', 'Paper A');
    markSent(db, '2401.00001', 0); // sent today
    const result = fetchOnDemandPapers(db, { respectDedup: false });
    expect(result).toHaveLength(1);
  });

  it('excludes papers sent within 1 day when respectDedup=true', () => {
    insertPaper(db, '2401.00001', 'Paper A');
    markSent(db, '2401.00001', 0); // sent today
    const result = fetchOnDemandPapers(db, { respectDedup: true });
    expect(result).toHaveLength(0);
  });

  it('includes papers sent more than 1 day ago when respectDedup=true', () => {
    insertPaper(db, '2401.00002', 'Paper B');
    markSent(db, '2401.00002', 2); // sent 2 days ago
    const result = fetchOnDemandPapers(db, { respectDedup: true });
    expect(result).toHaveLength(1);
  });

  it('filters by track (case-insensitive)', () => {
    insertPaper(db, '2401.00001', 'LLM Paper', 'Abstract', 'LLM Efficiency', 5);
    insertPaper(db, '2401.00002', 'CV Paper', 'Abstract', 'Computer Vision', 5);
    const result = fetchOnDemandPapers(db, { track: 'llm' });
    expect(result).toHaveLength(1);
    expect(result[0]!.trackName).toBe('LLM Efficiency');
  });

  it('returns papers from all tracks when no track filter', () => {
    insertPaper(db, '2401.00001', 'LLM Paper', 'Abstract', 'LLM Efficiency', 5);
    insertPaper(db, '2401.00002', 'CV Paper', 'Abstract', 'Computer Vision', 5);
    const result = fetchOnDemandPapers(db);
    expect(result).toHaveLength(2);
  });

  it('respects the limit option', () => {
    for (let i = 1; i <= 15; i++) {
      insertPaper(db, `2401.${String(i).padStart(5, '0')}`, `Paper ${i}`);
    }
    const result = fetchOnDemandPapers(db, { limit: 5 });
    expect(result).toHaveLength(5);
  });

  it('caps limit at 20', () => {
    for (let i = 1; i <= 25; i++) {
      insertPaper(db, `2401.${String(i).padStart(5, '0')}`, `Paper ${i}`);
    }
    const result = fetchOnDemandPapers(db, { limit: 999 });
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('filters out papers with llmScore below minScore', () => {
    insertPaper(db, '2401.00001', 'High relevance', 'Abstract', 'LLM', 5, 5);
    insertPaper(db, '2401.00002', 'Low relevance', 'Abstract', 'LLM', 5, 1);
    const result = fetchOnDemandPapers(db, { minScore: 3 });
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe('High relevance');
  });

  it('includes papers with null llmScore regardless of minScore', () => {
    insertPaper(db, '2401.00001', 'No LLM score', 'Abstract', 'LLM', 5, null);
    const result = fetchOnDemandPapers(db, { minScore: 4 });
    expect(result).toHaveLength(1);
  });

  it('includes absUrl built from arxiv_id when meta_path is missing', () => {
    insertPaper(db, '2401.00001', 'Paper A');
    const result = fetchOnDemandPapers(db);
    expect(result[0]!.absUrl).toBe('https://arxiv.org/abs/2401.00001');
  });

  it('returns matchedTerms parsed from JSON', () => {
    insertPaper(db, '2401.00001', 'Paper A');
    const result = fetchOnDemandPapers(db);
    expect(result[0]!.matchedTerms).toEqual(['transformer', 'attention']);
  });

  it('returns papers ordered by relevance score descending', () => {
    insertPaper(db, '2401.00001', 'Low score', 'Abstract', 'LLM', 3, 2);
    insertPaper(db, '2401.00002', 'High score', 'Abstract', 'LLM', 5, 5);
    // Both pass minScore=1
    const result = fetchOnDemandPapers(db, { minScore: 1 });
    expect(result[0]!.title).toBe('High score');
  });
});

// ── renderOnDemandReply ────────────────────────────────────────────────────

describe('renderOnDemandReply', () => {
  const paper = (id: string, track = 'LLM'): import('./ondemand-digest.js').OnDemandPaper => ({
    arxivId: id,
    title: `Paper ${id}`,
    abstract: 'This is a test abstract that describes the paper content.',
    absUrl: `https://arxiv.org/abs/${id}`,
    score: 5.0,
    llmScore: 4,
    matchedTerms: ['attention'],
    trackName: track,
  });

  it('returns empty-state message when no papers', () => {
    const { text, truncated } = renderOnDemandReply([], null);
    expect(text).toContain('No papers found');
    expect(truncated).toBe(false);
  });

  it('mentions track filter in empty-state when track given', () => {
    const { text } = renderOnDemandReply([], 'LLM');
    expect(text).toContain('"LLM"');
  });

  it('includes paper count in header', () => {
    const papers = [paper('2401.00001'), paper('2401.00002')];
    const { text } = renderOnDemandReply(papers, null);
    expect(text).toContain('2 papers');
  });

  it('includes arxiv URLs', () => {
    const { text } = renderOnDemandReply([paper('2401.00001')], null);
    expect(text).toContain('https://arxiv.org/abs/2401.00001');
  });

  it('includes track name when multiple tracks present', () => {
    const papers = [paper('2401.00001', 'LLM'), paper('2401.00002', 'CV')];
    const { text } = renderOnDemandReply(papers, null);
    expect(text).toContain('LLM');
    expect(text).toContain('CV');
  });

  it('includes relevance score', () => {
    const { text } = renderOnDemandReply([paper('2401.00001')], null);
    expect(text).toContain('relevance: 4/5');
  });

  it('includes feedback hint at the bottom', () => {
    const { text } = renderOnDemandReply([paper('2401.00001')], null);
    expect(text).toContain('/read');
  });
});

// ── runOnDemandDigest ──────────────────────────────────────────────────────

describe('runOnDemandDigest', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.sqlite.close();
  });

  it('returns empty result with no-papers reply when DB is empty', () => {
    const result = runOnDemandDigest(db);
    expect(result.totalFound).toBe(0);
    expect(result.reply).toContain('No papers found');
    expect(result.truncated).toBe(false);
  });

  it('returns found papers and a reply string', () => {
    insertPaper(db, '2401.00001', 'My Paper');
    const result = runOnDemandDigest(db);
    expect(result.totalFound).toBe(1);
    expect(result.papers[0]!.title).toBe('My Paper');
    expect(result.reply).toContain('My Paper');
  });

  it('sets trackFilter from opts.track', () => {
    insertPaper(db, '2401.00001', 'LLM Paper', 'Abstract', 'LLM Efficiency', 5);
    const result = runOnDemandDigest(db, { track: 'LLM' });
    expect(result.trackFilter).toBe('LLM');
    expect(result.totalFound).toBe(1);
  });

  it('returns trackFilter=null when no track specified', () => {
    const result = runOnDemandDigest(db);
    expect(result.trackFilter).toBeNull();
  });

  it('reply is a non-empty string', () => {
    insertPaper(db, '2401.00001', 'Test Paper');
    const { reply } = runOnDemandDigest(db);
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
  });
});

// ── parser integration — /digest command ─────────────────────────────────

describe('parseFeedbackMessage — /digest', () => {
  // Lazy import to avoid circular deps in test env
  let parse: typeof import('../feedback/parser.js').parseFeedbackMessage;

  beforeEach(async () => {
    const mod = await import('../feedback/parser.js');
    parse = mod.parseFeedbackMessage;
  });

  it('parses bare /digest as a query command', () => {
    const result = parse('/digest');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.command).toBe('digest');
      expect(result.query.track).toBeNull();
    }
  });

  it('parses /digest LLM with positional track arg', () => {
    const result = parse('/digest LLM');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.track).toBe('LLM');
    }
  });

  it('parses /digest --track "LLM Efficiency"', () => {
    const result = parse('/digest --track "LLM Efficiency"');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.track).toBe('LLM Efficiency');
    }
  });

  it('parses /digest --limit 5', () => {
    const result = parse('/digest --limit 5');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.limit).toBe(5);
    }
  });

  it('parses /digest --min-score 4', () => {
    const result = parse('/digest --min-score 4');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.minScore).toBe(4);
    }
  });

  it('parses /digest --dedup true', () => {
    const result = parse('/digest --dedup true');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.respectDedup).toBe(true);
    }
  });

  it('parses /digest LLM --limit 3 with both positional and flag', () => {
    const result = parse('/digest LLM --limit 3');
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === 'query') {
      expect(result.query.track).toBe('LLM');
      expect(result.query.limit).toBe(3);
    }
  });
});
