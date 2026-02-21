/**
 * Tests for /status, /stats, and /love → reading-list priority sync.
 *
 * Uses in-memory SQLite — no disk I/O, no config file required.
 * Exercises the recorder (love priority bump) and parser (/status, /stats commands).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from './migrate.js';
import { parseFeedbackMessage } from './parser.js';
import { recordFeedback } from './recorder.js';
import type { Db } from '../db.js';

// ── Test helpers ───────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

function seedPaper(db: Db, arxivId: string, title = 'Test Paper', daysAgo = 0) {
  const ingestedAt =
    daysAgo === 0
      ? "datetime('now')"
      : `datetime('now', '-${daysAgo} days')`;
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, 'Abstract.', '[]', '[]', ${ingestedAt}, ${ingestedAt},
               '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', ${ingestedAt})`,
    )
    .run(arxivId, title);
}

function getReadingListPriority(db: Db, arxivId: string): number | null {
  const row = db.sqlite
    .prepare('SELECT priority FROM reading_list WHERE paper_id = ?')
    .get(arxivId) as { priority: number } | undefined;
  return row?.priority ?? null;
}

// ── /status and /stats parser tests ───────────────────────────────────────

describe('parseFeedbackMessage /status', () => {
  it('parses bare /status as a query command', () => {
    const r = parseFeedbackMessage('/status');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.command).toBe('status');
    }
  });

  it('preserves raw text', () => {
    const r = parseFeedbackMessage('/status');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.raw).toBe('/status');
    }
  });

  it('does not treat /statuses as /status', () => {
    // /statuses is not a known command — should be an error, not /status
    const r = parseFeedbackMessage('/statuses');
    expect(r.ok).toBe(false);
  });
});

describe('parseFeedbackMessage /stats', () => {
  it('parses bare /stats with default 7-day window', () => {
    const r = parseFeedbackMessage('/stats');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.command).toBe('stats');
      expect(r.query.days).toBe(7);
    }
  });

  it('parses /stats --days 30', () => {
    const r = parseFeedbackMessage('/stats --days 30');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.days).toBe(30);
    }
  });

  it('clamps --days to max 90', () => {
    const r = parseFeedbackMessage('/stats --days 999');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      // out of range — falls back to default
      expect(r.query.days).toBe(7);
    }
  });

  it('parses /stats --days 1 (minimum)', () => {
    const r = parseFeedbackMessage('/stats --days 1');
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === 'query') {
      expect(r.query.days).toBe(1);
    }
  });
});

// ── /love → reading_list priority sync tests ───────────────────────────────

describe('/love → reading_list priority sync', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('bumps reading_list priority to 8 when paper is loved and was at priority 5', () => {
    seedPaper(db, '2403.00001');

    // Save first (priority 5)
    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'save', priority: 5 });
    expect(getReadingListPriority(db, '2403.00001')).toBe(5);

    // Love → should bump to 8
    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'love' });
    expect(getReadingListPriority(db, '2403.00001')).toBe(8);
  });

  it('does not lower priority if already above 8', () => {
    seedPaper(db, '2403.00002');

    // Save with high priority (9)
    recordFeedback({ db, arxivId: '2403.00002', feedbackType: 'save', priority: 9 });
    expect(getReadingListPriority(db, '2403.00002')).toBe(9);

    // Love → MAX(9, 8) = 9, should stay at 9
    recordFeedback({ db, arxivId: '2403.00002', feedbackType: 'love' });
    expect(getReadingListPriority(db, '2403.00002')).toBe(9);
  });

  it('does not crash when paper is loved but not in reading_list', () => {
    seedPaper(db, '2403.00003');

    // Love without saving first — should not error, and no reading_list row created
    expect(() => {
      recordFeedback({ db, arxivId: '2403.00003', feedbackType: 'love' });
    }).not.toThrow();

    const priority = getReadingListPriority(db, '2403.00003');
    expect(priority).toBeNull();
  });

  it('bumps priority from 3 to 8 on love', () => {
    seedPaper(db, '2403.00004');

    // Save with low priority
    recordFeedback({ db, arxivId: '2403.00004', feedbackType: 'save', priority: 3 });

    // Love → bumps to 8
    recordFeedback({ db, arxivId: '2403.00004', feedbackType: 'love' });
    expect(getReadingListPriority(db, '2403.00004')).toBe(8);
  });
});

// ── Status snapshot (direct DB query) tests ────────────────────────────────

describe('status snapshot queries', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('counts total papers correctly', () => {
    seedPaper(db, '2403.00001');
    seedPaper(db, '2403.00002');
    seedPaper(db, '2403.00003');

    const count = (db.sqlite.prepare('SELECT COUNT(*) as n FROM papers').get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it('counts papers ingested this week', () => {
    // 2 papers this week, 1 old paper
    seedPaper(db, '2403.00001', 'New Paper 1', 0);
    seedPaper(db, '2403.00002', 'New Paper 2', 2);
    seedPaper(db, '2403.00003', 'Old Paper', 10);

    const count = (
      db.sqlite
        .prepare(`SELECT COUNT(*) as n FROM papers WHERE ingested_at >= datetime('now', '-7 days')`)
        .get() as { n: number }
    ).n;
    expect(count).toBe(2);
  });

  it('counts unread reading list items', () => {
    seedPaper(db, '2403.00001');
    seedPaper(db, '2403.00002');

    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'save' });
    recordFeedback({ db, arxivId: '2403.00002', feedbackType: 'save' });
    // Mark one as read
    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'read' });

    const unread = (
      db.sqlite
        .prepare(`SELECT COUNT(*) as n FROM reading_list WHERE status IN ('unread', 'in_progress')`)
        .get() as { n: number }
    ).n;
    expect(unread).toBe(1);
  });

  it('counts feedback given this week', () => {
    seedPaper(db, '2403.00001');
    seedPaper(db, '2403.00002');
    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'love' });
    recordFeedback({ db, arxivId: '2403.00002', feedbackType: 'meh' });

    const count = (
      db.sqlite
        .prepare(
          `SELECT COUNT(*) as n FROM paper_feedback WHERE created_at >= datetime('now', '-7 days')`,
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(2);
  });
});

// ── Stats breakdown (direct DB query) tests ────────────────────────────────

describe('stats breakdown queries', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('groups feedback by type correctly', () => {
    seedPaper(db, '2403.00001');
    seedPaper(db, '2403.00002');
    seedPaper(db, '2403.00003');

    recordFeedback({ db, arxivId: '2403.00001', feedbackType: 'love' });
    recordFeedback({ db, arxivId: '2403.00002', feedbackType: 'love' });
    recordFeedback({ db, arxivId: '2403.00003', feedbackType: 'meh' });

    const counts = db.sqlite
      .prepare(
        `SELECT feedback_type, COUNT(*) as cnt FROM paper_feedback
         WHERE created_at >= datetime('now', '-7 days')
         GROUP BY feedback_type ORDER BY cnt DESC`,
      )
      .all() as Array<{ feedback_type: string; cnt: number }>;

    expect(counts).toHaveLength(2);
    expect(counts[0]).toMatchObject({ feedback_type: 'love', cnt: 2 });
    expect(counts[1]).toMatchObject({ feedback_type: 'meh', cnt: 1 });
  });

  it('returns empty feedback list when no activity', () => {
    const counts = db.sqlite
      .prepare(
        `SELECT feedback_type, COUNT(*) as cnt FROM paper_feedback
         WHERE created_at >= datetime('now', '-7 days')
         GROUP BY feedback_type`,
      )
      .all();

    expect(counts).toHaveLength(0);
  });
});
