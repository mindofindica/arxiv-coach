/**
 * Tests for streak.ts
 *
 * Covers:
 *   calcStreak      — current streak, longest streak, edge cases
 *   buildSparkline  — correct window, active/inactive chars
 *   countActiveDays — count within window
 *   computeStreakStats — end-to-end stats object
 *   formatStreakReply — output formatting
 *   getActiveDays   — DB query (in-memory SQLite)
 *
 * All time-sensitive calls use the `today` override parameter so tests
 * are deterministic regardless of when they run.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from '../feedback/migrate.js';
import type { Db } from '../db.js';
import {
  calcStreak,
  buildSparkline,
  countActiveDays,
  computeStreakStats,
  formatStreakReply,
  getActiveDays,
} from './streak.js';

// ── DB helpers ─────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

function seedFeedback(db: Db, paperId: string, dateStr: string, type = 'read'): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO paper_feedback
         (id, created_at, paper_id, feedback_type)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`${paperId}-${dateStr}-${type}`, `${dateStr}T12:00:00`, paperId, type);
}

// ── calcStreak ─────────────────────────────────────────────────────────────

describe('calcStreak', () => {
  it('returns 0 for empty array', () => {
    const result = calcStreak([], '2026-03-24');
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(0);
  });

  it('returns streak of 1 when only today is active', () => {
    const result = calcStreak(['2026-03-24'], '2026-03-24');
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it('returns streak of 1 when only yesterday is active (grace period)', () => {
    const result = calcStreak(['2026-03-23'], '2026-03-24');
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
  });

  it('returns 0 when last active day was 2+ days ago', () => {
    const result = calcStreak(['2026-03-22', '2026-03-21'], '2026-03-24');
    expect(result.currentStreak).toBe(0);
  });

  it('counts consecutive days correctly', () => {
    const days = ['2026-03-24', '2026-03-23', '2026-03-22', '2026-03-21'];
    const result = calcStreak(days, '2026-03-24');
    expect(result.currentStreak).toBe(4);
    expect(result.longestStreak).toBe(4);
  });

  it('stops streak at a gap', () => {
    // Gap on Mar 22 → streak only covers Mar 23–24
    const days = ['2026-03-24', '2026-03-23', '2026-03-21', '2026-03-20'];
    const result = calcStreak(days, '2026-03-24');
    expect(result.currentStreak).toBe(2);
  });

  it('finds longest streak that is not the current streak', () => {
    // Old run of 5, current run of 2
    const days = [
      '2026-03-24',
      '2026-03-23',
      // gap
      '2026-03-10',
      '2026-03-09',
      '2026-03-08',
      '2026-03-07',
      '2026-03-06',
    ];
    const result = calcStreak(days, '2026-03-24');
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(5);
  });

  it('handles single-day longest streak with no current streak', () => {
    const result = calcStreak(['2026-03-01'], '2026-03-24');
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(1);
  });

  it('handles duplicates in input gracefully', () => {
    const days = ['2026-03-24', '2026-03-24', '2026-03-23'];
    const result = calcStreak(days, '2026-03-24');
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(2);
  });

  it('today counts even when list is not sorted DESC', () => {
    const days = ['2026-03-22', '2026-03-23', '2026-03-24'];
    const result = calcStreak(days, '2026-03-24');
    expect(result.currentStreak).toBe(3);
  });
});

// ── buildSparkline ─────────────────────────────────────────────────────────

describe('buildSparkline', () => {
  it('returns all empty for no active days', () => {
    const line = buildSparkline([], 7, '2026-03-24');
    expect(line).toBe('░░░░░░░');
  });

  it('returns all filled when every day is active', () => {
    const days = ['2026-03-24', '2026-03-23', '2026-03-22', '2026-03-21', '2026-03-20'];
    const line = buildSparkline(days, 5, '2026-03-24');
    expect(line).toBe('█████');
  });

  it('correct length equals windowDays', () => {
    const line = buildSparkline([], 14, '2026-03-24');
    expect(line).length(14);
  });

  it('fills today at rightmost position', () => {
    const line = buildSparkline(['2026-03-24'], 3, '2026-03-24');
    expect(line).toBe('░░█');
  });

  it('fills yesterday in correct position', () => {
    const line = buildSparkline(['2026-03-23'], 3, '2026-03-24');
    expect(line).toBe('░█░');
  });

  it('fills oldest day at leftmost position', () => {
    const line = buildSparkline(['2026-03-22'], 3, '2026-03-24');
    expect(line).toBe('█░░');
  });

  it('ignores days outside the window', () => {
    // Day before the 3-day window should not appear
    const line = buildSparkline(['2026-03-21', '2026-03-24'], 3, '2026-03-24');
    expect(line).toBe('░░█');
  });
});

// ── countActiveDays ────────────────────────────────────────────────────────

describe('countActiveDays', () => {
  it('returns 0 for no active days', () => {
    expect(countActiveDays([], 30, '2026-03-24')).toBe(0);
  });

  it('counts correctly within window', () => {
    const days = ['2026-03-24', '2026-03-20', '2026-03-10'];
    expect(countActiveDays(days, 30, '2026-03-24')).toBe(3);
  });

  it('excludes days outside window', () => {
    // Window of 3 from Mar 22–24; Mar 20 is outside
    const days = ['2026-03-24', '2026-03-23', '2026-03-20'];
    expect(countActiveDays(days, 3, '2026-03-24')).toBe(2);
  });
});

// ── computeStreakStats ─────────────────────────────────────────────────────

describe('computeStreakStats', () => {
  it('all-zero stats for empty input', () => {
    const stats = computeStreakStats([], 30, 14, '2026-03-24');
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(0);
    expect(stats.activeDaysCount).toBe(0);
    expect(stats.sparkline).toHaveLength(14);
    expect(stats.sparkline).toBe('░'.repeat(14));
  });

  it('computes all fields together', () => {
    const days = ['2026-03-24', '2026-03-23', '2026-03-22'];
    const stats = computeStreakStats(days, 30, 14, '2026-03-24');
    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
    expect(stats.activeDaysCount).toBe(3);
    expect(stats.windowDays).toBe(30);
    expect(stats.sparklineWindowDays).toBe(14);
    expect(stats.sparkline.at(-1)).toBe('█'); // today is filled
  });
});

// ── formatStreakReply ──────────────────────────────────────────────────────

describe('formatStreakReply', () => {
  it('shows no-streak message when currentStreak is 0', () => {
    const stats = computeStreakStats([], 30, 14, '2026-03-24');
    const reply = formatStreakReply(stats);
    expect(reply).toContain('No current streak');
    expect(reply).toContain('Start today');
  });

  it('shows fire emoji for streak >= 7', () => {
    const days = Array.from({ length: 10 }, (_, i) => {
      const d = new Date('2026-03-24T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10);
    });
    const stats = computeStreakStats(days, 30, 14, '2026-03-24');
    const reply = formatStreakReply(stats);
    expect(reply).toContain('🔥');
    expect(reply).toContain("You're on fire");
  });

  it('includes longest streak', () => {
    const days = ['2026-03-24', '2026-03-23'];
    const stats = computeStreakStats(days, 30, 14, '2026-03-24');
    const reply = formatStreakReply(stats);
    expect(reply).toContain('Longest');
  });

  it('includes active days count and window', () => {
    const days = ['2026-03-24'];
    const stats = computeStreakStats(days, 30, 14, '2026-03-24');
    const reply = formatStreakReply(stats);
    expect(reply).toContain('last 30 days');
  });

  it('includes sparkline', () => {
    const days = ['2026-03-24'];
    const stats = computeStreakStats(days, 30, 14, '2026-03-24');
    const reply = formatStreakReply(stats);
    expect(reply).toContain('█');
    expect(reply).toContain('last 14 days');
  });
});

// ── getActiveDays (DB integration) ────────────────────────────────────────

describe('getActiveDays', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns empty array when no feedback exists', () => {
    const days = getActiveDays(db, 90);
    expect(days).toEqual([]);
  });

  it('returns one entry per active day (deduped)', () => {
    // Two feedback events on the same day → should count as one day
    seedFeedback(db, '2403.00001', '2026-03-24', 'read');
    seedFeedback(db, '2403.00002', '2026-03-24', 'save');
    const days = getActiveDays(db, 90);
    expect(days).toHaveLength(1);
    expect(days[0]).toBe('2026-03-24');
  });

  it('returns multiple days in descending order', () => {
    seedFeedback(db, '2403.00001', '2026-03-22', 'read');
    seedFeedback(db, '2403.00002', '2026-03-24', 'read');
    seedFeedback(db, '2403.00003', '2026-03-23', 'read');
    const days = getActiveDays(db, 90);
    expect(days).toEqual(['2026-03-24', '2026-03-23', '2026-03-22']);
  });

  it('respects window parameter', () => {
    // seed a day 100 days ago — should be excluded by a 90-day window
    db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO paper_feedback (id, created_at, paper_id, feedback_type)
         VALUES ('old-1', datetime('now', '-100 days'), '2403.00001', 'read')`,
      )
      .run();
    const days = getActiveDays(db, 90);
    expect(days).toHaveLength(0);
  });

  it('different feedback types on different days are all counted', () => {
    seedFeedback(db, '2403.00001', '2026-03-20', 'skip');
    seedFeedback(db, '2403.00002', '2026-03-21', 'love');
    seedFeedback(db, '2403.00003', '2026-03-22', 'meh');
    const days = getActiveDays(db, 90);
    expect(days).toHaveLength(3);
  });
});
