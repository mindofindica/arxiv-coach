/**
 * progress.ts — Weekly learning velocity snapshot for /progress command.
 *
 * Answers: "Am I reading more or less than last week?"
 *
 * Computes:
 *   - Papers rated this week vs last week (absolute + trend direction)
 *   - 4-week rolling average for context
 *   - Feedback type breakdown: engaged (love/read/save) vs passive (meh/skip)
 *   - Average LLM score of papers you've engaged with (trend)
 *   - Papers ingested this week vs last week (supply side)
 *   - Engagement rate: ratings / papers_ingested
 *
 * All date arithmetic is done in UTC. The caller can supply `today` (YYYY-MM-DD)
 * for deterministic tests.
 */

import type { Db } from '../db.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeekStats {
  /** ISO week start date (Monday), e.g. "2026-03-23" */
  weekStart: string;
  /** ISO week end date (Sunday), e.g. "2026-03-29" */
  weekEnd: string;
  /** Total feedback entries (all types) */
  totalFeedback: number;
  /** Engaged feedback: love + read + save */
  engaged: number;
  /** Passive feedback: meh + skip */
  passive: number;
  /** Papers ingested this week */
  papersIngested: number;
  /** Engagement rate: engaged / papersIngested (0–1, or null if 0 papers) */
  engagementRate: number | null;
  /** Average LLM score of engaged papers (1–5), or null if no LLM data */
  avgLlmScore: number | null;
}

export interface ProgressData {
  /** This week's stats */
  thisWeek: WeekStats;
  /** Last week's stats */
  lastWeek: WeekStats;
  /** 4-week rolling average of engaged feedback count */
  rollingAvgEngaged: number;
  /** Trend: positive = improving, negative = declining, 0 = flat */
  trendDirection: 'up' | 'down' | 'flat';
  /** Percentage change in engaged feedback vs last week (null if lastWeek.engaged == 0) */
  pctChange: number | null;
  /** Whether engagement rate improved this week */
  engagementRateImproved: boolean | null;
  /** Whether avg LLM score improved (papers are higher quality) */
  scoreImproved: boolean | null;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/** Returns Monday of the ISO week containing `date` (YYYY-MM-DD) */
export function isoWeekMonday(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysToMonday);
  return d.toISOString().slice(0, 10);
}

/** Returns Sunday of the ISO week starting on `monday` (YYYY-MM-DD) */
export function isoWeekSunday(monday: string): string {
  const d = new Date(monday + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** Add N days to a YYYY-MM-DD date string */
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's UTC date as YYYY-MM-DD */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── DB queries ───────────────────────────────────────────────────────────────

interface FeedbackCountRow {
  feedback_type: string;
  n: number;
}

interface LlmScoreRow {
  avg_score: number | null;
}

interface PapersIngestedRow {
  n: number;
}

/** Get per-type feedback counts for a date range [start, end] inclusive */
function getFeedbackCounts(db: Db, start: string, end: string): Record<string, number> {
  const rows = db.sqlite
    .prepare(
      `SELECT feedback_type, COUNT(*) as n
       FROM paper_feedback
       WHERE date(created_at) >= ? AND date(created_at) <= ?
       GROUP BY feedback_type`,
    )
    .all(start, end) as FeedbackCountRow[];

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.feedback_type] = row.n;
  }
  return counts;
}

/** Get average LLM relevance score of engaged papers in a date range */
function getAvgLlmScore(db: Db, start: string, end: string): number | null {
  // paper_scores table may not exist on all installations — degrade gracefully
  try {
    const row = db.sqlite
      .prepare(
        `SELECT AVG(ps.max_score) as avg_score
         FROM (
           SELECT pf.paper_id, MAX(ps2.relevance_score) as max_score
           FROM paper_feedback pf
           JOIN paper_scores ps2 ON ps2.arxiv_id = pf.paper_id
           WHERE pf.feedback_type IN ('love', 'read', 'save')
             AND date(pf.created_at) >= ?
             AND date(pf.created_at) <= ?
           GROUP BY pf.paper_id
         ) ps`,
      )
      .get(start, end) as LlmScoreRow;

    return row?.avg_score ?? null;
  } catch {
    // Table doesn't exist yet
    return null;
  }
}

/** Count papers ingested in a date range */
function getPapersIngested(db: Db, start: string, end: string): number {
  // Check if ingested_at column exists (it may not on older DBs)
  const tableInfo = db.sqlite.prepare(`PRAGMA table_info(papers)`).all() as { name: string }[];
  const hasIngestedAt = tableInfo.some(col => col.name === 'ingested_at');

  if (!hasIngestedAt) return 0;

  const row = db.sqlite
    .prepare(
      `SELECT COUNT(*) as n FROM papers
       WHERE date(ingested_at) >= ? AND date(ingested_at) <= ?`,
    )
    .get(start, end) as PapersIngestedRow;

  return row?.n ?? 0;
}

/** Build WeekStats for a given week starting on `monday` */
function buildWeekStats(db: Db, monday: string): WeekStats {
  const sunday = isoWeekSunday(monday);
  const counts = getFeedbackCounts(db, monday, sunday);

  const engaged = (counts['love'] ?? 0) + (counts['read'] ?? 0) + (counts['save'] ?? 0);
  const passive = (counts['meh'] ?? 0) + (counts['skip'] ?? 0);
  const totalFeedback = engaged + passive;

  const papersIngested = getPapersIngested(db, monday, sunday);
  const engagementRate = papersIngested > 0 ? engaged / papersIngested : null;

  const avgLlmScore = getAvgLlmScore(db, monday, sunday);

  return {
    weekStart: monday,
    weekEnd: sunday,
    totalFeedback,
    engaged,
    passive,
    papersIngested,
    engagementRate,
    avgLlmScore,
  };
}

/** Calculate 4-week rolling average of engaged feedback */
function calcRollingAvg(db: Db, currentMonday: string): number {
  let total = 0;
  let monday = currentMonday;

  for (let i = 0; i < 4; i++) {
    const stats = buildWeekStats(db, monday);
    total += stats.engaged;
    monday = addDays(monday, -7);
  }

  return total / 4;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build the weekly progress data.
 *
 * @param db      - Open Db instance
 * @param today   - Override today's date (YYYY-MM-DD) for testing
 */
export function buildProgressData(db: Db, today?: string): ProgressData {
  const todayStr = today ?? todayUtc();
  const thisMonday = isoWeekMonday(todayStr);
  const lastMonday = addDays(thisMonday, -7);

  const thisWeek = buildWeekStats(db, thisMonday);
  const lastWeek = buildWeekStats(db, lastMonday);
  const rollingAvgEngaged = calcRollingAvg(db, lastMonday); // 4 weeks prior to this week

  // Trend
  let trendDirection: 'up' | 'down' | 'flat';
  let pctChange: number | null = null;

  if (lastWeek.engaged === 0) {
    trendDirection = thisWeek.engaged > 0 ? 'up' : 'flat';
  } else {
    const delta = thisWeek.engaged - lastWeek.engaged;
    pctChange = Math.round((delta / lastWeek.engaged) * 100);
    if (Math.abs(pctChange) < 10) {
      trendDirection = 'flat';
    } else {
      trendDirection = delta > 0 ? 'up' : 'down';
    }
  }

  // Engagement rate trend
  let engagementRateImproved: boolean | null = null;
  if (thisWeek.engagementRate !== null && lastWeek.engagementRate !== null) {
    engagementRateImproved = thisWeek.engagementRate > lastWeek.engagementRate;
  }

  // Score trend
  let scoreImproved: boolean | null = null;
  if (thisWeek.avgLlmScore !== null && lastWeek.avgLlmScore !== null) {
    scoreImproved = thisWeek.avgLlmScore > lastWeek.avgLlmScore;
  }

  return {
    thisWeek,
    lastWeek,
    rollingAvgEngaged,
    trendDirection,
    pctChange,
    engagementRateImproved,
    scoreImproved,
  };
}
