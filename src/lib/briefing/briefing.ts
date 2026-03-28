/**
 * Weekly Personal Briefing
 *
 * Builds a structured data object for Mikey's Monday morning AI research digest.
 * This is distinct from /weekly (paper volume + top papers) and /stats (feedback counts):
 *
 * It is *narrative*, *personal*, and *proactive*. It shows up in Signal every Monday at 09:00 CET.
 *
 * Structure:
 *   1. Greeting + week label
 *   2. Reading streak (current / longest / sparkline)
 *   3. Feedback activity (loved/read/skipped/saved counts + engagement rate)
 *   4. Top 3 highest-scored papers of the week (with one-line highlight)
 *   5. "You might have missed" — high-score papers not in any digest Mikey received
 *   6. Streak nudge (if streak is at risk or strong)
 *
 * Data sources:
 *   - paper_feedback (streak, engagement)
 *   - papers + track_matches + paper_scores (top papers)
 *   - sent_digests + digest_papers (dedup — what Mikey already received)
 *   - sent_weekly_briefings (idempotency)
 *
 * Key design choices:
 *   - Does NOT require the reading-streak branch to be merged; streak logic is inlined.
 *   - Gracefully degrades when tables are missing (e.g. paper_scores, digest_papers).
 *   - "You might have missed" uses a 14-day window (current week + prior week buffer).
 */

import type { Db } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  activeDaysInWindow: number;
  windowDays: number;
  sparkline: string;
}

export interface FeedbackActivity {
  loved: number;
  read: number;
  saved: number;
  skipped: number;
  meh: number;
  total: number;
  /** Fraction of ingested papers Mikey engaged with (read/love/save/meh) 0-1 */
  engagementRate: number | null;
  /** Total papers ingested in the same period */
  papersIngested: number;
}

export interface TopPaperHighlight {
  arxivId: string;
  title: string;
  tracks: string[];
  llmScore: number | null;
  keywordScore: number;
  absUrl: string;
  /** One-line highlight from abstract (first sentence, max 160 chars) */
  highlight: string;
}

export interface MissedPaper {
  arxivId: string;
  title: string;
  tracks: string[];
  llmScore: number | null;
  absUrl: string;
}

export interface WeeklyBriefingData {
  kind: 'weeklyBriefing';
  weekIso: string;
  dateRange: { start: string; end: string };
  generatedAt: string;
  streak: StreakInfo;
  feedback: FeedbackActivity;
  topPapers: TopPaperHighlight[];
  missedPapers: MissedPaper[];
  /** True if a briefing was already sent for this week */
  alreadySent: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Current ISO week string, e.g. "2026-W13" */
export function currentIsoWeek(now = new Date()): string {
  // ISO 8601: week 1 is the week containing the first Thursday.
  const jan4 = new Date(Date.UTC(now.getUTCFullYear(), 0, 4));
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));

  const daysSinceWeek1 = Math.floor((now.getTime() - startOfWeek1.getTime()) / 86_400_000);
  const weekNum = Math.floor(daysSinceWeek1 / 7) + 1;
  const year = now.getUTCFullYear();

  // Edge: if weekNum > 52/53, it belongs to next year
  const maxWeeks = isoWeeksInYear(year);
  if (weekNum > maxWeeks) {
    return `${year + 1}-W01`;
  }
  // Edge: if daysSinceWeek1 < 0, it belongs to last year
  if (daysSinceWeek1 < 0) {
    return `${year - 1}-W${String(isoWeeksInYear(year - 1)).padStart(2, '0')}`;
  }

  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function isoWeeksInYear(year: number): number {
  // A year has 53 ISO weeks if Jan 1 or Dec 31 is Thursday.
  const jan1Day = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const dec31Day = new Date(Date.UTC(year, 11, 31)).getUTCDay();
  return jan1Day === 4 || dec31Day === 4 ? 53 : 52;
}

/**
 * Return the Monday and Sunday of a given ISO week as YYYY-MM-DD strings.
 */
export function weekDateRange(weekIso: string): { start: string; end: string } {
  const m = weekIso.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO week: ${weekIso}`);
  const year = parseInt(m[1]!, 10);
  const week = parseInt(m[2]!, 10);

  // Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

function subtractDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Build a ▓/░ sparkline for the last windowDays days */
function buildSparkline(activeDaySet: Set<string>, windowDays: number, today: string): string {
  const blocks: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = subtractDays(today, i);
    blocks.push(activeDaySet.has(day) ? '▓' : '░');
  }
  return blocks.join('');
}

/** Extract first sentence from abstract, capped at maxChars */
function extractHighlight(abstract: string, maxChars = 160): string {
  // Try first sentence
  const match = abstract.match(/^[^.!?]+[.!?]/);
  const candidate = match ? match[0]!.trim() : abstract.slice(0, maxChars).trim();
  return candidate.length > maxChars ? candidate.slice(0, maxChars - 1) + '…' : candidate;
}

// ── DB Row Types ───────────────────────────────────────────────────────────

interface FeedbackDayRow {
  day: string;
}

interface FeedbackCountRow {
  feedback_type: string;
  cnt: number;
}

interface PaperCountRow {
  n: number;
}

interface TopPaperRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  llm_score: number | null;
  keyword_score: number;
  tracks_concat: string;
}

interface BriefingSentRow {
  week_iso: string;
  sent_at: string;
}

// ── Streak calculation (inlined — does not require reading-streak branch) ──

interface CalcStreakResult {
  currentStreak: number;
  longestStreak: number;
}

function calcStreakFromDays(activeDays: string[], today: string): CalcStreakResult {
  if (activeDays.length === 0) return { currentStreak: 0, longestStreak: 0 };

  // Deduplicate and sort descending
  const unique = [...new Set(activeDays)].sort().reverse();
  const todayMs = new Date(today + 'T00:00:00Z').getTime();
  const yesterdayStr = subtractDays(today, 1);

  // Current streak: consecutive days ending today or yesterday
  let currentStreak = 0;
  if (unique[0] === today || unique[0] === yesterdayStr) {
    let expected = unique[0]!;
    for (const day of unique) {
      if (day === expected) {
        currentStreak++;
        expected = subtractDays(expected, 1);
      } else {
        break;
      }
    }
  }

  // Longest streak: scan all active days
  let longestStreak = 0;
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    const prevMs = new Date(unique[i - 1]! + 'T00:00:00Z').getTime();
    const currMs = new Date(unique[i]! + 'T00:00:00Z').getTime();
    const diffDays = Math.round((prevMs - currMs) / 86_400_000);
    if (diffDays === 1) {
      run++;
    } else {
      longestStreak = Math.max(longestStreak, run);
      run = 1;
    }
  }
  longestStreak = Math.max(longestStreak, run, currentStreak);

  return { currentStreak, longestStreak };
}

// ── Idempotency ────────────────────────────────────────────────────────────

export function ensureBriefingTable(db: Db): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sent_weekly_briefings (
      week_iso TEXT PRIMARY KEY,
      sent_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sent_weekly_briefings_sent_at
      ON sent_weekly_briefings(sent_at);
  `);
}

export function hasBriefingBeenSent(db: Db, weekIso: string): boolean {
  ensureBriefingTable(db);
  const row = db.sqlite
    .prepare('SELECT week_iso FROM sent_weekly_briefings WHERE week_iso = ?')
    .get(weekIso) as BriefingSentRow | undefined;
  return !!row;
}

export function markBriefingSent(db: Db, weekIso: string): void {
  ensureBriefingTable(db);
  db.sqlite
    .prepare(
      `INSERT INTO sent_weekly_briefings (week_iso, sent_at)
       VALUES (?, ?)
       ON CONFLICT(week_iso) DO UPDATE SET sent_at = excluded.sent_at`,
    )
    .run(weekIso, new Date().toISOString());
}

// ── Main data gathering ─────────────────────────────────────────────────────

export interface BuildBriefingOptions {
  /** ISO week to report on. Defaults to current week. */
  weekIso?: string;
  /** Override today's date (YYYY-MM-DD) for testing */
  today?: string;
  /** Number of days for streak sparkline (default 14) */
  sparklineWindowDays?: number;
  /** Max top papers to include (default 3) */
  maxTopPapers?: number;
  /** Max missed papers to include (default 3) */
  maxMissedPapers?: number;
  /** Min LLM score for "you might have missed" section (default 4) */
  minMissedScore?: number;
}

export function buildWeeklyBriefing(db: Db, opts: BuildBriefingOptions = {}): WeeklyBriefingData {
  const {
    sparklineWindowDays = 14,
    maxTopPapers = 3,
    maxMissedPapers = 3,
    minMissedScore = 4,
  } = opts;

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const weekIso = opts.weekIso ?? currentIsoWeek(new Date(today + 'T12:00:00Z'));
  const dateRange = weekDateRange(weekIso);

  ensureBriefingTable(db);
  const alreadySent = hasBriefingBeenSent(db, weekIso);

  // ── Streak ──────────────────────────────────────────────────────────────
  const streakWindowDays = 90;
  const activeDayRows = db.sqlite
    .prepare(
      `SELECT DATE(created_at) as day
       FROM paper_feedback
       WHERE created_at >= datetime('now', '-${streakWindowDays} days')
       GROUP BY DATE(created_at)
       ORDER BY day DESC`,
    )
    .all() as FeedbackDayRow[];

  const activeDays = activeDayRows.map((r) => r.day);
  const activeDaySet = new Set(activeDays);
  const { currentStreak, longestStreak } = calcStreakFromDays(activeDays, today);
  const sparkline = buildSparkline(activeDaySet, sparklineWindowDays, today);

  const streak: StreakInfo = {
    currentStreak,
    longestStreak,
    activeDaysInWindow: activeDays.length,
    windowDays: streakWindowDays,
    sparkline,
  };

  // ── Feedback activity (last 7 days) ──────────────────────────────────────
  const feedbackRows = db.sqlite
    .prepare(
      `SELECT feedback_type, COUNT(*) as cnt
       FROM paper_feedback
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY feedback_type`,
    )
    .all() as FeedbackCountRow[];

  const feedbackMap: Record<string, number> = {};
  for (const row of feedbackRows) {
    feedbackMap[row.feedback_type] = row.cnt;
  }

  const loved = feedbackMap['love'] ?? 0;
  const read = feedbackMap['read'] ?? 0;
  const saved = feedbackMap['save'] ?? 0;
  const skipped = feedbackMap['skip'] ?? 0;
  const meh = feedbackMap['meh'] ?? 0;
  const total = loved + read + saved + skipped + meh;

  // Papers ingested in the last 7 days
  const papersIngested =
    (
      db.sqlite
        .prepare(`SELECT COUNT(*) as n FROM papers WHERE ingested_at >= datetime('now', '-7 days')`)
        .get() as PaperCountRow
    ).n;

  const engagementRate =
    papersIngested > 0 ? Math.min(1, (loved + read + saved + meh) / papersIngested) : null;

  const feedback: FeedbackActivity = {
    loved,
    read,
    saved,
    skipped,
    meh,
    total,
    engagementRate,
    papersIngested,
  };

  // ── Top papers this week (by LLM score, then keyword score) ───────────────
  // Uses track_matches for keyword scores; tries paper_scores for LLM scores.
  const weekStart = dateRange.start + 'T00:00:00Z';
  const weekEndExclusive = addDays(dateRange.end, 1) + 'T00:00:00Z';

  let topPaperRows: TopPaperRow[] = [];
  try {
    topPaperRows = db.sqlite
      .prepare(
        `SELECT
           p.arxiv_id,
           p.title,
           p.abstract,
           ps.llm_score,
           MAX(tm.score) AS keyword_score,
           GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
         FROM papers p
         JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
         LEFT JOIN paper_scores ps ON ps.arxiv_id = p.arxiv_id
         WHERE tm.matched_at >= ? AND tm.matched_at < ?
         GROUP BY p.arxiv_id
         ORDER BY
           CASE WHEN ps.llm_score IS NOT NULL THEN ps.llm_score ELSE 0 END DESC,
           keyword_score DESC
         LIMIT ?`,
      )
      .all(weekStart, weekEndExclusive, maxTopPapers) as TopPaperRow[];
  } catch {
    // paper_scores table may not exist — fall back without LLM score
    topPaperRows = db.sqlite
      .prepare(
        `SELECT
           p.arxiv_id,
           p.title,
           p.abstract,
           NULL as llm_score,
           MAX(tm.score) AS keyword_score,
           GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
         FROM papers p
         JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
         WHERE tm.matched_at >= ? AND tm.matched_at < ?
         GROUP BY p.arxiv_id
         ORDER BY keyword_score DESC
         LIMIT ?`,
      )
      .all(weekStart, weekEndExclusive, maxTopPapers) as TopPaperRow[];
  }

  const topPapers: TopPaperHighlight[] = topPaperRows.map((row) => ({
    arxivId: row.arxiv_id,
    title: row.title,
    tracks: row.tracks_concat ? row.tracks_concat.split(',') : [],
    llmScore: row.llm_score ?? null,
    keywordScore: row.keyword_score,
    absUrl: `https://arxiv.org/abs/${row.arxiv_id}`,
    highlight: extractHighlight(row.abstract),
  }));

  // ── "You might have missed" — high-score papers not sent in any digest ────
  // Looks back 14 days. Tries digest_papers for sent-paper tracking.
  // Falls back to sent_digests (date-based) if digest_papers doesn't exist.
  const missedWindowStart = subtractDays(today, 14) + 'T00:00:00Z';

  let missedPaperRows: TopPaperRow[] = [];
  try {
    // Try to use digest_papers table for precise per-paper dedup
    missedPaperRows = db.sqlite
      .prepare(
        `SELECT
           p.arxiv_id,
           p.title,
           p.abstract,
           ps.llm_score,
           MAX(tm.score) AS keyword_score,
           GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
         FROM papers p
         JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
         LEFT JOIN paper_scores ps ON ps.arxiv_id = p.arxiv_id
         WHERE tm.matched_at >= ?
           AND (ps.llm_score IS NULL OR ps.llm_score >= ?)
           AND p.arxiv_id NOT IN (
             SELECT arxiv_id FROM digest_papers
             WHERE sent_at >= ?
           )
         GROUP BY p.arxiv_id
         ORDER BY
           CASE WHEN ps.llm_score IS NOT NULL THEN ps.llm_score ELSE 0 END DESC,
           keyword_score DESC
         LIMIT ?`,
      )
      .all(missedWindowStart, minMissedScore, missedWindowStart, maxMissedPapers) as TopPaperRow[];
  } catch {
    // digest_papers doesn't exist — use a simpler query without dedup
    try {
      missedPaperRows = db.sqlite
        .prepare(
          `SELECT
             p.arxiv_id,
             p.title,
             p.abstract,
             ps.llm_score,
             MAX(tm.score) AS keyword_score,
             GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
           FROM papers p
           JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
           LEFT JOIN paper_scores ps ON ps.arxiv_id = p.arxiv_id
           WHERE tm.matched_at >= ?
             AND (ps.llm_score IS NULL OR ps.llm_score >= ?)
           GROUP BY p.arxiv_id
           ORDER BY
             CASE WHEN ps.llm_score IS NOT NULL THEN ps.llm_score ELSE 0 END DESC,
             keyword_score DESC
           LIMIT ?`,
        )
        .all(missedWindowStart, minMissedScore, maxMissedPapers) as TopPaperRow[];
    } catch {
      // paper_scores also missing — purely keyword-based
      missedPaperRows = db.sqlite
        .prepare(
          `SELECT
             p.arxiv_id,
             p.title,
             p.abstract,
             NULL as llm_score,
             MAX(tm.score) AS keyword_score,
             GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
           FROM papers p
           JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
           WHERE tm.matched_at >= ?
           GROUP BY p.arxiv_id
           ORDER BY keyword_score DESC
           LIMIT ?`,
        )
        .all(missedWindowStart, maxMissedPapers) as TopPaperRow[];
    }
  }

  // Exclude papers that are already in topPapers to avoid overlap
  const topPaperIds = new Set(topPapers.map((p) => p.arxivId));
  const missedPapers: MissedPaper[] = missedPaperRows
    .filter((row) => !topPaperIds.has(row.arxiv_id))
    .slice(0, maxMissedPapers)
    .map((row) => ({
      arxivId: row.arxiv_id,
      title: row.title,
      tracks: row.tracks_concat ? row.tracks_concat.split(',') : [],
      llmScore: row.llm_score ?? null,
      absUrl: `https://arxiv.org/abs/${row.arxiv_id}`,
    }));

  return {
    kind: 'weeklyBriefing',
    weekIso,
    dateRange,
    generatedAt: new Date().toISOString(),
    streak,
    feedback,
    topPapers,
    missedPapers,
    alreadySent,
  };
}
