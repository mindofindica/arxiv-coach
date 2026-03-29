/**
 * streak.ts — Reading streak calculation for arxiv-coach.
 *
 * A "day" counts as active if the user recorded any feedback action
 * (read/save/love/meh/skip) on that date.
 *
 * Data comes from the `paper_feedback` table — any row on a given date
 * counts as an active day.
 *
 * Exports:
 *   getActiveDays(db, windowDays)    — query DB → sorted-DESC array of YYYY-MM-DD strings
 *   calcStreak(activeDays, today?)   — compute current + longest streak
 *   buildSparkline(activeDays, windowDays, today?) — generate ▓/░ sparkline string
 *   formatStreakReply(data)          — produce Signal-friendly reply string
 */

import type { Db } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreakStats {
  currentStreak: number;
  longestStreak: number;
  activeDaysCount: number;
  windowDays: number;
  sparkline: string;
  sparklineWindowDays: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return today's date as 'YYYY-MM-DD' (UTC).
 * Accepts an optional override for testing.
 */
function todayUTC(override?: string): string {
  if (override !== undefined) return override;
  return new Date().toISOString().slice(0, 10);
}

/**
 * Subtract N days from a YYYY-MM-DD string, returning a new YYYY-MM-DD string.
 */
function subtractDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Add N days to a YYYY-MM-DD string, returning a new YYYY-MM-DD string.
 */
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── DB query ────────────────────────────────────────────────────────────────

interface DayRow {
  day: string;
}

/**
 * Query the DB for all active days in the last `windowDays` days.
 * Returns a sorted-DESC array of YYYY-MM-DD strings.
 * Each date appears at most once regardless of how many actions occurred.
 */
export function getActiveDays(db: Db, windowDays = 90): string[] {
  const rows = db.sqlite
    .prepare(
      `SELECT DATE(created_at) as day
       FROM paper_feedback
       WHERE created_at >= datetime('now', '-${windowDays} days')
       GROUP BY DATE(created_at)
       ORDER BY day DESC`,
    )
    .all() as DayRow[];

  return rows.map((r) => r.day);
}

// ── Streak calculation ──────────────────────────────────────────────────────

export interface CalcStreakResult {
  currentStreak: number;
  longestStreak: number;
}

/**
 * Calculate current and longest reading streaks.
 *
 * @param activeDays  Sorted-DESC array of YYYY-MM-DD strings (from getActiveDays).
 *                    Duplicates are handled gracefully.
 * @param today       Override for today's date (YYYY-MM-DD) — used in tests.
 */
export function calcStreak(activeDays: string[], today?: string): CalcStreakResult {
  if (activeDays.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  const todayStr = todayUTC(today);
  const daySet = new Set(activeDays);

  // ── Current streak ────────────────────────────────────────────────────
  // Streak is active if today OR yesterday was active (grace period for timezones / late nights)
  let currentStreak = 0;
  const yesterdayStr = subtractDays(todayStr, 1);

  let startDate: string | null = null;
  if (daySet.has(todayStr)) {
    startDate = todayStr;
  } else if (daySet.has(yesterdayStr)) {
    startDate = yesterdayStr;
  }

  if (startDate !== null) {
    let cursor = startDate;
    while (daySet.has(cursor)) {
      currentStreak++;
      cursor = subtractDays(cursor, 1);
    }
  }

  // ── Longest streak ─────────────────────────────────────────────────────
  // Sort ascending so YYYY-MM-DD lexicographic order = chronological order
  const sorted = [...daySet].sort();
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;

  for (const day of sorted) {
    if (prev === null) {
      run = 1;
    } else {
      // Check if this day is exactly 1 day after prev
      const expected = addDays(prev, 1);
      run = day === expected ? run + 1 : 1;
    }
    if (run > longestStreak) longestStreak = run;
    prev = day;
  }

  return { currentStreak, longestStreak };
}

// ── Sparkline ───────────────────────────────────────────────────────────────

const FILLED = '█';
const EMPTY = '░';

/**
 * Build a text sparkline for the last `windowDays` days (default 14).
 * Each character represents one day (oldest on left, newest on right).
 * █ = active, ░ = inactive.
 *
 * @param activeDays  Sorted-DESC array of YYYY-MM-DD strings.
 * @param windowDays  Number of days to show (default 14).
 * @param today       Override for today's date (YYYY-MM-DD) — used in tests.
 */
export function buildSparkline(activeDays: string[], windowDays = 14, today?: string): string {
  const todayStr = todayUTC(today);
  const daySet = new Set(activeDays);

  const chars: string[] = [];
  // Build from oldest → newest
  for (let i = windowDays - 1; i >= 0; i--) {
    const day = subtractDays(todayStr, i);
    chars.push(daySet.has(day) ? FILLED : EMPTY);
  }

  return chars.join('');
}

// ── Active days count ───────────────────────────────────────────────────────

/**
 * Count active days within the last `windowDays` days relative to today.
 */
export function countActiveDays(activeDays: string[], windowDays: number, today?: string): number {
  const todayStr = todayUTC(today);
  const startDate = subtractDays(todayStr, windowDays - 1);
  return activeDays.filter((d) => d >= startDate && d <= todayStr).length;
}

// ── Full stats ──────────────────────────────────────────────────────────────

/**
 * Compute full streak stats from a list of active days.
 * This is a pure function — all DB interaction is done in getActiveDays().
 *
 * @param activeDays      Sorted-DESC YYYY-MM-DD strings from getActiveDays().
 * @param windowDays      Window for "active N of last X days" count (default 30).
 * @param sparklineWindow Window for sparkline display (default 14).
 * @param today           Today override for tests.
 */
export function computeStreakStats(
  activeDays: string[],
  windowDays = 30,
  sparklineWindow = 14,
  today?: string,
): StreakStats {
  const { currentStreak, longestStreak } = calcStreak(activeDays, today);
  const activeDaysCount = countActiveDays(activeDays, windowDays, today);
  const sparkline = buildSparkline(activeDays, sparklineWindow, today);

  return {
    currentStreak,
    longestStreak,
    activeDaysCount,
    windowDays,
    sparkline,
    sparklineWindowDays: sparklineWindow,
  };
}

// ── Formatter ───────────────────────────────────────────────────────────────

/**
 * Format streak stats as a Signal-friendly multi-line reply.
 */
export function formatStreakReply(stats: StreakStats): string {
  const { currentStreak, longestStreak, activeDaysCount, windowDays, sparkline } = stats;

  const lines: string[] = [];

  // Headline with flame emoji calibrated to streak length
  const flameIcon = currentStreak >= 7 ? '🔥' : currentStreak >= 3 ? '🌟' : currentStreak >= 1 ? '✨' : '💤';
  const streakLabel =
    currentStreak === 0
      ? 'No current streak'
      : `${currentStreak} day${currentStreak === 1 ? '' : 's'}`;

  lines.push(`${flameIcon} Current streak: ${streakLabel}`);
  lines.push(`📈 Longest: ${longestStreak} day${longestStreak === 1 ? '' : 's'}`);
  lines.push(`📅 Active: ${activeDaysCount} of last ${windowDays} days`);
  lines.push('');
  lines.push(`${sparkline}  ← last ${stats.sparklineWindowDays} days`);

  if (currentStreak === 0) {
    lines.push('');
    lines.push('Start today — rate any paper to begin a streak! 📄');
  } else if (currentStreak >= 7) {
    lines.push('');
    lines.push("You're on fire. Keep going! 🚀");
  }

  return lines.join('\n');
}
