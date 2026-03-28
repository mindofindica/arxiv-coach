/**
 * Tests for weekly briefing: data gathering, idempotency, and rendering.
 *
 * All tests use in-memory SQLite — no disk I/O, no config file required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { ensureFeedbackTables } from '../feedback/migrate.js';
import {
  buildWeeklyBriefing,
  currentIsoWeek,
  weekDateRange,
  hasBriefingBeenSent,
  markBriefingSent,
  ensureBriefingTable,
} from './briefing.js';
import { renderWeeklyBriefing } from './render-briefing.js';
import type { Db } from '../db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  ensureBriefingTable(db);
  return db;
}

function seedPaper(db: Db, arxivId: string, title = 'Test Paper', abstract = 'We present a novel approach. More details here.'): void {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, ?, '[]', '[]',
               datetime('now'), datetime('now'),
               '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    )
    .run(arxivId, title, abstract);
}

function seedTrackMatch(
  db: Db,
  arxivId: string,
  trackName: string,
  score = 3,
  matchedAt?: string,
): void {
  const at = matchedAt ?? new Date().toISOString();
  db.sqlite
    .prepare(
      `INSERT OR REPLACE INTO track_matches
         (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '[]', ?)`,
    )
    .run(arxivId, trackName, score, at);
}

function seedFeedback(
  db: Db,
  arxivId: string,
  feedbackType: string,
  createdAt?: string,
): void {
  const at = createdAt ?? new Date().toISOString();
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO paper_feedback
         (id, created_at, paper_id, feedback_type)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?)`,
    )
    .run(at, arxivId, feedbackType);
}

// ── currentIsoWeek ─────────────────────────────────────────────────────────

describe('currentIsoWeek', () => {
  it('returns a valid ISO week string format', () => {
    const week = currentIsoWeek(new Date('2026-03-28T12:00:00Z'));
    expect(week).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('returns W13 for 2026-03-28 (Saturday)', () => {
    // 2026-03-28 is a Saturday in week 13
    const week = currentIsoWeek(new Date('2026-03-28T12:00:00Z'));
    expect(week).toBe('2026-W13');
  });

  it('returns W01 for 2026-01-01', () => {
    const week = currentIsoWeek(new Date('2026-01-01T12:00:00Z'));
    expect(week).toBe('2026-W01');
  });

  it('returns W53 for 2020-12-31 (year with 53 weeks)', () => {
    // 2020 had 53 ISO weeks; Dec 31 2020 is a Thursday (still in W53)
    const week = currentIsoWeek(new Date('2020-12-31T12:00:00Z'));
    expect(week).toBe('2020-W53');
  });
});

// ── weekDateRange ──────────────────────────────────────────────────────────

describe('weekDateRange', () => {
  it('returns Monday→Sunday for 2026-W13', () => {
    const { start, end } = weekDateRange('2026-W13');
    // W13 2026: Mon 23 Mar → Sun 29 Mar
    expect(start).toBe('2026-03-23');
    expect(end).toBe('2026-03-29');
  });

  it('returns Monday→Sunday for 2026-W01', () => {
    const { start, end } = weekDateRange('2026-W01');
    expect(start).toBe('2025-12-29');
    expect(end).toBe('2026-01-04');
  });

  it('throws for invalid format', () => {
    expect(() => weekDateRange('2026-13')).toThrow('Invalid ISO week');
  });
});

// ── idempotency ─────────────────────────────────────────────────────────────

describe('briefing idempotency', () => {
  it('hasBriefingBeenSent returns false initially', () => {
    const db = makeTestDb();
    expect(hasBriefingBeenSent(db, '2026-W13')).toBe(false);
  });

  it('hasBriefingBeenSent returns true after markBriefingSent', () => {
    const db = makeTestDb();
    markBriefingSent(db, '2026-W13');
    expect(hasBriefingBeenSent(db, '2026-W13')).toBe(true);
  });

  it('does not affect other weeks', () => {
    const db = makeTestDb();
    markBriefingSent(db, '2026-W13');
    expect(hasBriefingBeenSent(db, '2026-W12')).toBe(false);
    expect(hasBriefingBeenSent(db, '2026-W14')).toBe(false);
  });

  it('is idempotent — marking twice does not throw', () => {
    const db = makeTestDb();
    expect(() => {
      markBriefingSent(db, '2026-W13');
      markBriefingSent(db, '2026-W13');
    }).not.toThrow();
    expect(hasBriefingBeenSent(db, '2026-W13')).toBe(true);
  });

  it('alreadySent is reflected in briefing data', () => {
    const db = makeTestDb();
    markBriefingSent(db, '2026-W13');
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.alreadySent).toBe(true);
  });

  it('alreadySent is false for unsent week', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.alreadySent).toBe(false);
  });
});

// ── streak ─────────────────────────────────────────────────────────────────

describe('briefing streak', () => {
  it('returns zero streak on empty DB', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.streak.currentStreak).toBe(0);
    expect(data.streak.longestStreak).toBe(0);
  });

  it('counts consecutive days correctly', () => {
    const db = makeTestDb();
    // Use different papers per day to avoid UNIQUE(paper_id, feedback_type) constraint
    seedPaper(db, '2603.00001');
    seedPaper(db, '2603.00002');
    seedPaper(db, '2603.00003');
    // 3 consecutive days ending today
    seedFeedback(db, '2603.00001', 'read', '2026-03-28T10:00:00Z');
    seedFeedback(db, '2603.00002', 'read', '2026-03-27T10:00:00Z');
    seedFeedback(db, '2603.00003', 'read', '2026-03-26T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.streak.currentStreak).toBe(3);
    expect(data.streak.longestStreak).toBe(3);
  });

  it('breaks streak on gap day', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    seedPaper(db, '2603.00002');
    seedFeedback(db, '2603.00001', 'read', '2026-03-28T10:00:00Z');
    // gap on 2026-03-27
    seedFeedback(db, '2603.00002', 'read', '2026-03-26T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.streak.currentStreak).toBe(1);
  });

  it('builds sparkline with correct length', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      sparklineWindowDays: 7,
    });
    expect(data.streak.sparkline).toHaveLength(7);
  });

  it('sparkline contains only ▓ and ░', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    seedFeedback(db, '2603.00001', 'read', '2026-03-28T10:00:00Z');
    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      sparklineWindowDays: 7,
    });
    expect(data.streak.sparkline).toMatch(/^[▓░]+$/);
  });

  it('marks active days with ▓ in sparkline', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    // Active only on 2026-03-28 (today, last position)
    seedFeedback(db, '2603.00001', 'read', '2026-03-28T10:00:00Z');
    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      sparklineWindowDays: 7,
    });
    // Last char should be ▓ (today is active)
    expect(data.streak.sparkline.at(-1)).toBe('▓');
    // All others should be ░ (no activity on prior days)
    expect(data.streak.sparkline.slice(0, -1)).toBe('░'.repeat(6));
  });
});

// ── feedback activity ────────────────────────────────────────────────────────

describe('briefing feedback activity', () => {
  it('returns zero counts on empty DB', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.feedback.total).toBe(0);
    expect(data.feedback.loved).toBe(0);
    expect(data.feedback.engagementRate).toBeNull();
  });

  it('counts feedback types correctly', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    seedPaper(db, '2603.00002');
    seedPaper(db, '2603.00003');
    seedFeedback(db, '2603.00001', 'love');
    seedFeedback(db, '2603.00002', 'read');
    seedFeedback(db, '2603.00003', 'skip');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.feedback.loved).toBe(1);
    expect(data.feedback.read).toBe(1);
    expect(data.feedback.skipped).toBe(1);
    expect(data.feedback.total).toBe(3);
  });

  it('ignores feedback older than 7 days', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    // Feedback from 10 days ago — should not count
    seedFeedback(db, '2603.00001', 'love', '2026-03-18T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.feedback.total).toBe(0);
  });

  it('calculates engagement rate when papers ingested', () => {
    const db = makeTestDb();
    // Seed papers and mark them ingested recently
    for (let i = 1; i <= 10; i++) {
      seedPaper(db, `2603.0000${i}`);
    }
    // Rate 3 of them
    seedFeedback(db, '2603.00001', 'love');
    seedFeedback(db, '2603.00002', 'read');
    seedFeedback(db, '2603.00003', 'save');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    // Engagement = (love + read + save + meh) / papersIngested = 3/10 = 0.3
    expect(data.feedback.engagementRate).toBeCloseTo(0.3, 1);
  });
});

// ── top papers ────────────────────────────────────────────────────────────

describe('briefing top papers', () => {
  it('returns empty array when no papers this week', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers).toEqual([]);
  });

  it('returns papers matched this week', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Great Paper About Agents');
    // Match within W13 (Mon 23 Mar → Sun 29 Mar)
    seedTrackMatch(db, '2603.00001', 'LLM', 8, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers).toHaveLength(1);
    expect(data.topPapers[0]!.arxivId).toBe('2603.00001');
    expect(data.topPapers[0]!.title).toBe('Great Paper About Agents');
    expect(data.topPapers[0]!.tracks).toContain('LLM');
  });

  it('excludes papers matched outside this week', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Old Paper');
    // Match 2 weeks ago
    seedTrackMatch(db, '2603.00001', 'LLM', 8, '2026-03-10T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers).toHaveLength(0);
  });

  it('respects maxTopPapers limit', () => {
    const db = makeTestDb();
    for (let i = 1; i <= 5; i++) {
      seedPaper(db, `2603.0000${i}`);
      seedTrackMatch(db, `2603.0000${i}`, 'LLM', i, '2026-03-25T10:00:00Z');
    }

    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      maxTopPapers: 2,
    });
    expect(data.topPapers).toHaveLength(2);
  });

  it('includes absUrl in correct format', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    seedTrackMatch(db, '2603.00001', 'LLM', 5, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers[0]!.absUrl).toBe('https://arxiv.org/abs/2603.00001');
  });

  it('extracts first sentence as highlight', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Paper', 'We propose a new method. It is very good. Even more stuff.');
    seedTrackMatch(db, '2603.00001', 'LLM', 5, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers[0]!.highlight).toBe('We propose a new method.');
  });

  it('truncates highlight at 160 chars', () => {
    const longAbstract = 'A'.repeat(200);
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Paper', longAbstract);
    seedTrackMatch(db, '2603.00001', 'LLM', 5, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.topPapers[0]!.highlight.length).toBeLessThanOrEqual(161); // 160 + possible ellipsis
  });
});

// ── missed papers ─────────────────────────────────────────────────────────

describe('briefing missed papers', () => {
  it('returns empty array when no papers in window', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.missedPapers).toEqual([]);
  });

  it('does not overlap with top papers', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Top Paper');
    // Match this week (shows up in top papers)
    seedTrackMatch(db, '2603.00001', 'LLM', 9, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      maxTopPapers: 3,
      maxMissedPapers: 3,
    });

    const topIds = data.topPapers.map((p) => p.arxivId);
    const missedIds = data.missedPapers.map((p) => p.arxivId);
    const overlap = topIds.filter((id) => missedIds.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('respects maxMissedPapers limit', () => {
    const db = makeTestDb();
    for (let i = 1; i <= 5; i++) {
      seedPaper(db, `2603.0000${i}`);
      // Match 5 days ago (within 14-day window)
      seedTrackMatch(db, `2603.0000${i}`, 'LLM', i, '2026-03-23T10:00:00Z');
    }

    const data = buildWeeklyBriefing(db, {
      weekIso: '2026-W13',
      today: '2026-03-28',
      maxMissedPapers: 2,
    });
    expect(data.missedPapers.length).toBeLessThanOrEqual(2);
  });
});

// ── buildWeeklyBriefing structure ─────────────────────────────────────────

describe('buildWeeklyBriefing', () => {
  it('returns correct kind', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.kind).toBe('weeklyBriefing');
  });

  it('includes weekIso and dateRange', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(data.weekIso).toBe('2026-W13');
    expect(data.dateRange.start).toBe('2026-03-23');
    expect(data.dateRange.end).toBe('2026-03-29');
  });

  it('includes generatedAt as ISO timestamp', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    expect(new Date(data.generatedAt).toISOString()).toBe(data.generatedAt);
  });

  it('uses current ISO week when weekIso not provided', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { today: '2026-03-28' });
    expect(data.weekIso).toBe('2026-W13');
  });
});

// ── renderWeeklyBriefing ──────────────────────────────────────────────────

describe('renderWeeklyBriefing', () => {
  it('returns a string with correct format', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(50);
  });

  it('includes week number in header', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('W13');
  });

  it('includes date range', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('Mon 23 Mar');
    expect(text).toContain('Sun 29 Mar');
  });

  it('includes streak info', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('streak');
  });

  it('includes feedback section', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('Last 7 days');
  });

  it('includes top paper titles when present', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'Transformers Are All You Need');
    seedTrackMatch(db, '2603.00001', 'LLM', 5, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('Transformers Are All You Need');
  });

  it('includes arxiv URL for top papers', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001', 'My Paper');
    seedTrackMatch(db, '2603.00001', 'LLM', 5, '2026-03-25T10:00:00Z');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('https://arxiv.org/abs/2603.00001');
  });

  it('includes nudge when streak is zero', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    // Should encourage starting a streak
    expect(text).toContain('/read');
  });

  it('includes positive nudge for 7+ day streak', () => {
    const db = makeTestDb();
    // Use a different paper per day to avoid UNIQUE(paper_id, feedback_type) constraint
    for (let i = 0; i < 7; i++) {
      const arxivId = `2603.0010${i}`;
      seedPaper(db, arxivId);
      const at = new Date('2026-03-28T10:00:00Z');
      at.setUTCDate(at.getUTCDate() - i);
      seedFeedback(db, arxivId, 'read', at.toISOString());
    }

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    // 7-day streak matching personal best → "new personal best" or "on a roll"
    expect(text).toMatch(/personal best|roll|🔥|🏆/);
  });

  it('returns truncated=false for a normal briefing', () => {
    const db = makeTestDb();
    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { truncated } = renderWeeklyBriefing(data);
    expect(truncated).toBe(false);
  });

  it('renders emoji feedback icons when feedback exists', () => {
    const db = makeTestDb();
    seedPaper(db, '2603.00001');
    seedFeedback(db, '2603.00001', 'love');

    const data = buildWeeklyBriefing(db, { weekIso: '2026-W13', today: '2026-03-28' });
    const { text } = renderWeeklyBriefing(data);
    expect(text).toContain('❤️');
  });
});
