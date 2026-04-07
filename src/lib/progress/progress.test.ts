/**
 * Tests for progress.ts and render-progress.ts
 *
 * Covers:
 *   isoWeekMonday  — correct Monday detection including edge cases
 *   isoWeekSunday  — correct Sunday detection
 *   addDays        — simple date arithmetic
 *   buildProgressData — full progress computation (with in-memory SQLite)
 *   renderProgressReply — output formatting for various scenarios
 *
 * All date-sensitive calls use `today` override for determinism.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from '../feedback/migrate.js';
import type { Db } from '../db.js';
import {
  isoWeekMonday,
  isoWeekSunday,
  addDays,
  buildProgressData,
  type ProgressData,
} from './progress.js';
import { renderProgressReply } from './render-progress.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

let paperSeq = 0;
function seedFeedback(db: Db, date: string, type: string, paperId?: string): void {
  const pid = paperId ?? `paper-${++paperSeq}`;
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`fb-${pid}-${type}`, `${date}T12:00:00`, pid, type);
}

function seedPaper(db: Db, arxivId: string, ingestedAt: string): void {
  // Check if ingested_at column exists
  const tableInfo = db.sqlite.prepare(`PRAGMA table_info(papers)`).all() as { name: string }[];
  const hasIngestedAt = tableInfo.some(col => col.name === 'ingested_at');
  if (!hasIngestedAt) return;

  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers (arxiv_id, title, ingested_at)
       VALUES (?, ?, ?)`,
    )
    .run(arxivId, `Title for ${arxivId}`, ingestedAt);
}

// ── isoWeekMonday ─────────────────────────────────────────────────────────────

describe('isoWeekMonday', () => {
  it('returns Monday for a Monday', () => {
    expect(isoWeekMonday('2026-03-23')).toBe('2026-03-23'); // Monday
  });

  it('returns Monday for a Wednesday', () => {
    expect(isoWeekMonday('2026-03-25')).toBe('2026-03-23');
  });

  it('returns Monday for a Sunday', () => {
    expect(isoWeekMonday('2026-03-29')).toBe('2026-03-23');
  });

  it('returns Monday for a Saturday', () => {
    expect(isoWeekMonday('2026-03-28')).toBe('2026-03-23');
  });

  it('handles week crossing month boundary', () => {
    // 2026-03-30 is a Monday
    expect(isoWeekMonday('2026-04-01')).toBe('2026-03-30');
  });

  it('handles week crossing year boundary', () => {
    // 2025-12-29 is a Monday (first week of 2026 ISO)
    expect(isoWeekMonday('2026-01-01')).toBe('2025-12-29');
  });
});

// ── isoWeekSunday ─────────────────────────────────────────────────────────────

describe('isoWeekSunday', () => {
  it('returns Sunday 6 days after Monday', () => {
    expect(isoWeekSunday('2026-03-23')).toBe('2026-03-29');
  });

  it('handles month boundary', () => {
    expect(isoWeekSunday('2026-03-30')).toBe('2026-04-05');
  });
});

// ── addDays ───────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds positive days', () => {
    expect(addDays('2026-03-23', 7)).toBe('2026-03-30');
  });

  it('subtracts with negative', () => {
    expect(addDays('2026-03-23', -7)).toBe('2026-03-16');
  });

  it('handles month crossing', () => {
    expect(addDays('2026-03-29', 2)).toBe('2026-03-31');
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
  });
});

// ── buildProgressData — empty DB ──────────────────────────────────────────────

describe('buildProgressData — empty DB', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    paperSeq = 0;
  });

  it('returns zero stats for empty DB', () => {
    const data = buildProgressData(db, '2026-03-25');
    expect(data.thisWeek.engaged).toBe(0);
    expect(data.thisWeek.totalFeedback).toBe(0);
    expect(data.lastWeek.engaged).toBe(0);
    expect(data.trendDirection).toBe('flat');
    expect(data.pctChange).toBeNull();
  });

  it('thisWeek.weekStart is the Monday of the current week', () => {
    const data = buildProgressData(db, '2026-03-25'); // Wednesday
    expect(data.thisWeek.weekStart).toBe('2026-03-23');
  });

  it('lastWeek.weekStart is the Monday 7 days prior', () => {
    const data = buildProgressData(db, '2026-03-25');
    expect(data.lastWeek.weekStart).toBe('2026-03-16');
  });
});

// ── buildProgressData — feedback ──────────────────────────────────────────────

describe('buildProgressData — feedback counting', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    paperSeq = 0;
  });

  it('counts engaged feedback (love/read/save) correctly', () => {
    seedFeedback(db, '2026-03-23', 'love');
    seedFeedback(db, '2026-03-24', 'read');
    seedFeedback(db, '2026-03-25', 'save');
    seedFeedback(db, '2026-03-26', 'meh');
    seedFeedback(db, '2026-03-27', 'skip');

    const data = buildProgressData(db, '2026-03-25');
    expect(data.thisWeek.engaged).toBe(3); // love + read + save
    expect(data.thisWeek.passive).toBe(2); // meh + skip
    expect(data.thisWeek.totalFeedback).toBe(5);
  });

  it('counts last week correctly', () => {
    seedFeedback(db, '2026-03-16', 'read'); // last week Mon
    seedFeedback(db, '2026-03-18', 'love'); // last week Wed
    seedFeedback(db, '2026-03-23', 'read'); // this week Mon

    const data = buildProgressData(db, '2026-03-25');
    expect(data.lastWeek.engaged).toBe(2);
    expect(data.thisWeek.engaged).toBe(1);
  });

  it('does not count feedback from outside the week range', () => {
    seedFeedback(db, '2026-03-15', 'read'); // day before last week
    seedFeedback(db, '2026-03-30', 'love'); // day after this week

    const data = buildProgressData(db, '2026-03-25');
    expect(data.thisWeek.engaged).toBe(0);
    expect(data.lastWeek.engaged).toBe(0);
  });

  it('counts feedback on the boundary days (Monday and Sunday)', () => {
    seedFeedback(db, '2026-03-23', 'read'); // Mon
    seedFeedback(db, '2026-03-29', 'read'); // Sun

    const data = buildProgressData(db, '2026-03-25');
    expect(data.thisWeek.engaged).toBe(2);
  });
});

// ── buildProgressData — trend ─────────────────────────────────────────────────

describe('buildProgressData — trend direction', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    paperSeq = 0;
  });

  it('trend is up when this week > last week by >10%', () => {
    // Last week: 4, This week: 6 (+50%)
    for (let i = 0; i < 4; i++) seedFeedback(db, '2026-03-17', 'read');
    for (let i = 0; i < 6; i++) seedFeedback(db, '2026-03-24', 'read');

    const data = buildProgressData(db, '2026-03-25');
    expect(data.trendDirection).toBe('up');
    expect(data.pctChange).toBe(50);
  });

  it('trend is down when this week < last week by >10%', () => {
    // Last week: 5, This week: 2 (-60%)
    for (let i = 0; i < 5; i++) seedFeedback(db, '2026-03-17', 'read');
    for (let i = 0; i < 2; i++) seedFeedback(db, '2026-03-24', 'read');

    const data = buildProgressData(db, '2026-03-25');
    expect(data.trendDirection).toBe('down');
    expect(data.pctChange).toBe(-60);
  });

  it('trend is flat when change is <10%', () => {
    // Last week: 10, This week: 10 (0%)
    for (let i = 0; i < 10; i++) seedFeedback(db, '2026-03-17', 'read');
    for (let i = 0; i < 10; i++) seedFeedback(db, '2026-03-24', 'read');

    const data = buildProgressData(db, '2026-03-25');
    expect(data.trendDirection).toBe('flat');
    expect(data.pctChange).toBe(0);
  });

  it('trend is up when last week was 0 and this week > 0', () => {
    seedFeedback(db, '2026-03-24', 'read');
    const data = buildProgressData(db, '2026-03-25');
    expect(data.trendDirection).toBe('up');
    expect(data.pctChange).toBeNull(); // no last week baseline
  });

  it('trend is flat when both weeks are 0', () => {
    const data = buildProgressData(db, '2026-03-25');
    expect(data.trendDirection).toBe('flat');
    expect(data.pctChange).toBeNull();
  });
});

// ── buildProgressData — rolling average ───────────────────────────────────────

describe('buildProgressData — rolling average', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
    paperSeq = 0;
  });

  it('computes 4-week average of prior weeks (not including this week)', () => {
    // Weeks: -1 (last): 4, -2: 3, -3: 2, -4: 1 → avg = 2.5
    for (let i = 0; i < 4; i++) seedFeedback(db, '2026-03-17', 'read'); // -1 week
    for (let i = 0; i < 3; i++) seedFeedback(db, '2026-03-10', 'read'); // -2 weeks
    for (let i = 0; i < 2; i++) seedFeedback(db, '2026-03-03', 'read'); // -3 weeks
    for (let i = 0; i < 1; i++) seedFeedback(db, '2026-02-24', 'read'); // -4 weeks

    const data = buildProgressData(db, '2026-03-25');
    expect(data.rollingAvgEngaged).toBe(2.5);
  });
});

// ── renderProgressReply ───────────────────────────────────────────────────────

describe('renderProgressReply', () => {
  it('renders header with week number and date range', () => {
    const db = makeTestDb();
    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toContain('W13');
    expect(reply).toContain('23');
    expect(reply).toContain('Mar');
  });

  it('shows zero state with call to action', () => {
    const db = makeTestDb();
    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toMatch(/No reads logged|start with \/read/);
  });

  it('shows trend up message when improving', () => {
    const db = makeTestDb();
    for (let i = 0; i < 4; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-last-${i}`, `2026-03-17T12:00:00`, `p-last-${i}`, 'read');
    }
    for (let i = 0; i < 8; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-this-${i}`, `2026-03-24T12:00:00`, `p-this-${i}`, 'read');
    }

    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toMatch(/📈|🚀/);
  });

  it('shows trend down message when declining', () => {
    const db = makeTestDb();
    for (let i = 0; i < 8; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-last-${i}`, `2026-03-17T12:00:00`, `p-last-${i}`, 'read');
    }
    for (let i = 0; i < 2; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-this-${i}`, `2026-03-24T12:00:00`, `p-this-${i}`, 'read');
    }

    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toContain('📉');
  });

  it('shows pct change in output', () => {
    const db = makeTestDb();
    for (let i = 0; i < 4; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-l${i}`, `2026-03-17T12:00:00`, `p-l${i}`, 'read');
    }
    for (let i = 0; i < 6; i++) {
      db.sqlite.prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES (?, ?, ?, ?)`,
      ).run(`fb-t${i}`, `2026-03-24T12:00:00`, `p-t${i}`, 'read');
    }

    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toContain('+50%');
  });

  it('includes rolling average in output', () => {
    const db = makeTestDb();
    const data = buildProgressData(db, '2026-03-25');
    const reply = renderProgressReply(data);
    expect(reply).toMatch(/4-wk avg/);
  });

  it('does not throw on a fully populated dataset', () => {
    const db = makeTestDb();
    // Seed 4 weeks of data
    const dates = ['2026-02-24', '2026-03-03', '2026-03-10', '2026-03-17', '2026-03-23'];
    let pid = 0;
    for (const d of dates) {
      for (let i = 0; i < 5; i++) {
        db.sqlite.prepare(
          `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
           VALUES (?, ?, ?, ?)`,
        ).run(`fb-${++pid}`, `${d}T12:00:00`, `paper-${pid}`, i < 3 ? 'read' : 'skip');
      }
    }
    expect(() => {
      const data = buildProgressData(db, '2026-03-25');
      renderProgressReply(data);
    }).not.toThrow();
  });
});
