/**
 * Tests for /weekly command — parser flags and handler dispatch.
 *
 * Tests the parser (week, track flags) and the handler integration
 * (getWeeklySummary + renderWeeklySummaryMessage via dispatch).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from './migrate.js';
import { parseFeedbackMessage } from './parser.js';
import { getWeeklySummary } from '../query/weekly-summary.js';
import { renderWeeklySummaryMessage } from '../query/render-weekly-summary.js';
import type { Db } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

/** Insert a minimal paper row. */
function seedPaper(db: Db, arxivId: string, title = 'Test Paper'): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, 'Abstract.', '[]', '[]',
               datetime('now'), datetime('now'),
               '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    )
    .run(arxivId, title);
}

/** Insert a track match for a paper (defaults to current timestamp). */
function seedTrackMatch(
  db: Db,
  arxivId: string,
  trackName: string,
  score = 3,
  matchedAt?: string,
): void {
  const ts = matchedAt ?? new Date().toISOString();
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_matches
         (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '[]', ?)`,
    )
    .run(arxivId, trackName, score, ts);
}

/** Insert an LLM relevance score. */
function seedLlmScore(db: Db, arxivId: string, relevanceScore: number): void {
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO llm_scores
         (arxiv_id, relevance_score, reasoning, scored_at)
       VALUES (?, ?, 'test reasoning', datetime('now'))`,
    )
    .run(arxivId, relevanceScore);
}

/** A Monday timestamp in a given ISO week (week starts Monday). */
function mondayOfWeek(weekIso: string): string {
  // Parse "YYYY-Www"
  const m = weekIso.match(/^(\d{4})-W(\d{2})$/)!;
  const year = parseInt(m[1]!, 10);
  const week = parseInt(m[2]!, 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const target = new Date(week1Mon);
  target.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  return target.toISOString();
}

// ── Parser: /weekly command ────────────────────────────────────────────────

describe('parseFeedbackMessage /weekly', () => {
  it('parses bare /weekly as a query command', () => {
    const r = parseFeedbackMessage('/weekly');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.command).toBe('weekly');
      expect(r.query.week).toBeNull();
      expect(r.query.track).toBeNull();
    }
  });

  it('parses /weekly --week 2026-W07', () => {
    const r = parseFeedbackMessage('/weekly --week 2026-W07');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.command).toBe('weekly');
      expect(r.query.week).toBe('2026-W07');
    }
  });

  it('parses /weekly --week 2026-W08', () => {
    const r = parseFeedbackMessage('/weekly --week 2026-W08');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.week).toBe('2026-W08');
    }
  });

  it('rejects invalid --week format (leaves week null)', () => {
    const r = parseFeedbackMessage('/weekly --week 2026-08');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      // "2026-08" doesn't match YYYY-Www — should be ignored
      expect(r.query.week).toBeNull();
    }
  });

  it('parses /weekly --track LLM', () => {
    const r = parseFeedbackMessage('/weekly --track LLM');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.track).toBe('LLM');
    }
  });

  it('parses /weekly --week 2026-W07 --track RL', () => {
    const r = parseFeedbackMessage('/weekly --week 2026-W07 --track RL');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.week).toBe('2026-W07');
      expect(r.query.track).toBe('RL');
    }
  });

  it('preserves raw message text', () => {
    const input = '/weekly --week 2026-W07';
    const r = parseFeedbackMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.raw).toBe(input);
    }
  });

  it('does not require --week or --track (both default null)', () => {
    const r = parseFeedbackMessage('/weekly');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.week).toBeNull();
      expect(r.query.track).toBeNull();
    }
  });
});

// ── getWeeklySummary: data layer ───────────────────────────────────────────

describe('getWeeklySummary', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns empty summary for a week with no papers', () => {
    const summary = getWeeklySummary(db, '2026-W07');
    expect(summary.kind).toBe('weeklySummary');
    expect(summary.weekIso).toBe('2026-W07');
    expect(summary.totalPapers).toBe(0);
    expect(summary.trackStats).toHaveLength(0);
    expect(summary.topPapers).toHaveLength(0);
    expect(summary.deepDive.sent).toBe(false);
  });

  it('counts papers matched in the specified week', () => {
    seedPaper(db, '2501.00001', 'Paper One');
    seedPaper(db, '2501.00002', 'Paper Two');
    const monday = mondayOfWeek('2026-W07');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);
    seedTrackMatch(db, '2501.00002', 'RL', 4, monday);

    const summary = getWeeklySummary(db, '2026-W07');
    expect(summary.totalPapers).toBe(2);
    expect(summary.trackStats).toHaveLength(2);
  });

  it('does not count papers from a different week', () => {
    seedPaper(db, '2501.00001', 'Old Paper');
    // Put it in week 06
    const oldMonday = mondayOfWeek('2026-W06');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, oldMonday);

    const summary = getWeeklySummary(db, '2026-W07');
    expect(summary.totalPapers).toBe(0);
  });

  it('includes per-track counts', () => {
    seedPaper(db, '2501.00001', 'Paper One');
    seedPaper(db, '2501.00002', 'Paper Two');
    seedPaper(db, '2501.00003', 'Paper Three');
    const monday = mondayOfWeek('2026-W08');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);
    seedTrackMatch(db, '2501.00002', 'LLM', 4, monday);
    seedTrackMatch(db, '2501.00003', 'RL', 5, monday);

    const summary = getWeeklySummary(db, '2026-W08');
    expect(summary.totalPapers).toBe(3);

    const llmTrack = summary.trackStats.find(t => t.trackName === 'LLM');
    const rlTrack = summary.trackStats.find(t => t.trackName === 'RL');
    expect(llmTrack?.count).toBe(2);
    expect(rlTrack?.count).toBe(1);
  });

  it('populates topPapers with LLM scores when available', () => {
    seedPaper(db, '2501.00001', 'Top Paper');
    const monday = mondayOfWeek('2026-W08');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);
    seedLlmScore(db, '2501.00001', 5);

    const summary = getWeeklySummary(db, '2026-W08');
    expect(summary.topPapers).toHaveLength(1);
    expect(summary.topPapers[0]!.arxivId).toBe('2501.00001');
    expect(summary.topPapers[0]!.llmScore).toBe(5);
  });

  it('limits topPapers to maxTopPapers', () => {
    const monday = mondayOfWeek('2026-W08');
    for (let i = 1; i <= 10; i++) {
      seedPaper(db, `2501.000${String(i).padStart(2, '0')}`, `Paper ${i}`);
      seedTrackMatch(db, `2501.000${String(i).padStart(2, '0')}`, 'LLM', i, monday);
    }

    const summary = getWeeklySummary(db, '2026-W08', { maxTopPapers: 3 });
    expect(summary.topPapers).toHaveLength(3);
  });

  it('reports dateRange matching the ISO week', () => {
    const summary = getWeeklySummary(db, '2026-W07');
    // 2026-W07: Mon 2026-02-09 → Sun 2026-02-15
    expect(summary.dateRange.start).toBe('2026-02-09');
    expect(summary.dateRange.end).toBe('2026-02-15');
  });

  it('reports dateRange for 2026-W08', () => {
    const summary = getWeeklySummary(db, '2026-W08');
    // 2026-W08: Mon 2026-02-16 → Sun 2026-02-22
    expect(summary.dateRange.start).toBe('2026-02-16');
    expect(summary.dateRange.end).toBe('2026-02-22');
  });

  it('reports deep dive as not sent when none recorded', () => {
    const summary = getWeeklySummary(db, '2026-W08');
    expect(summary.deepDive.sent).toBe(false);
    expect(summary.deepDive.arxivId).toBeNull();
  });

  it('reports deep dive as sent when recorded in sent_weekly_digests', () => {
    seedPaper(db, '2501.00001', 'Deep Dive Paper');
    db.sqlite
      .prepare(
        `INSERT INTO sent_weekly_digests (week_iso, kind, arxiv_id, sent_at, sections_json)
         VALUES (?, 'weekly', ?, datetime('now'), '[]')`,
      )
      .run('2026-W08', '2501.00001');

    const summary = getWeeklySummary(db, '2026-W08');
    expect(summary.deepDive.sent).toBe(true);
    expect(summary.deepDive.arxivId).toBe('2501.00001');
    expect(summary.deepDive.title).toBe('Deep Dive Paper');
  });
});

// ── renderWeeklySummaryMessage: output format ──────────────────────────────

describe('renderWeeklySummaryMessage', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('renders empty-week message when totalPapers is 0', () => {
    const summary = getWeeklySummary(db, '2026-W07');
    const { text, truncated } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('No papers matched');
    expect(truncated).toBe(false);
  });

  it('renders header with week and date range', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'Paper A');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('2026-W08');
    expect(text).toContain('2026-02-16');
    expect(text).toContain('2026-02-22');
  });

  it('renders total paper count', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'Paper A');
    seedPaper(db, '2501.00002', 'Paper B');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);
    seedTrackMatch(db, '2501.00002', 'RL', 4, monday);

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('2 papers matched');
  });

  it('renders track breakdown', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'LLM Paper');
    seedTrackMatch(db, '2501.00001', 'Language Models', 3, monday);

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('Language Models');
  });

  it('renders deep dive status (not sent)', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'Paper A');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('not yet sent');
  });

  it('renders deep dive status (sent) with paper title', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'Paper A');
    seedTrackMatch(db, '2501.00001', 'LLM', 3, monday);
    db.sqlite
      .prepare(
        `INSERT INTO sent_weekly_digests (week_iso, kind, arxiv_id, sent_at, sections_json)
         VALUES (?, 'weekly', ?, datetime('now'), '[]')`,
      )
      .run('2026-W08', '2501.00001');

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    expect(text).toContain('sent');
    expect(text).toContain('Paper A');
  });

  it('includes LLM score emoji for high-scored papers', () => {
    const monday = mondayOfWeek('2026-W08');
    seedPaper(db, '2501.00001', 'Excellent Paper');
    seedTrackMatch(db, '2501.00001', 'LLM', 5, monday);
    seedLlmScore(db, '2501.00001', 5);

    const summary = getWeeklySummary(db, '2026-W08');
    const { text } = renderWeeklySummaryMessage(summary);
    // Score 5 should show 🔥
    expect(text).toContain('🔥');
  });
});
