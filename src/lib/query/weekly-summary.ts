import { readFileSync } from 'node:fs';
import type { Db } from '../db.js';
import { weekDateRange } from '../weekly/select.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TrackStat {
  trackName: string;
  /** Number of unique papers matched to this track this week */
  count: number;
  /** Highest keyword score for any paper in this track this week */
  topKeywordScore: number;
  /** Highest LLM relevance score (1-5) for any paper in this track, or null */
  topLlmScore: number | null;
}

export interface TopPaper {
  arxivId: string;
  title: string;
  /** Primary score: LLM relevance score (1-5) if available, else null */
  llmScore: number | null;
  /** Keyword match score */
  keywordScore: number;
  /** Tracks this paper matched */
  tracks: string[];
  absUrl: string | null;
}

export interface DeepDiveStatus {
  sent: boolean;
  /** arxiv ID of the deep dive paper, if sent */
  arxivId: string | null;
  /** Title of the deep dive paper, if available */
  title: string | null;
}

export interface WeeklySummary {
  kind: 'weeklySummary';
  weekIso: string;
  /** ISO date range strings for display */
  dateRange: {
    start: string; // e.g. "2026-02-16"
    end: string;   // e.g. "2026-02-22"
  };
  /** Total unique papers ingested (track-matched) this week */
  totalPapers: number;
  /** Per-track breakdown */
  trackStats: TrackStat[];
  /** Top papers by score (up to 5) */
  topPapers: TopPaper[];
  /** Weekly deep dive status */
  deepDive: DeepDiveStatus;
}

// ─── DB Row Types ─────────────────────────────────────────────────────────────

interface TrackCountRow {
  trackName: string;
  count: number;
  topKeywordScore: number;
  topLlmScore: number | null;
}

interface TopPaperRow {
  arxivId: string;
  title: string;
  llmScore: number | null;
  keywordScore: number;
  tracksConcat: string;
  metaPath: string;
}

interface SentWeeklyRow {
  weekIso: string;
  arxivId: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Build a weekly summary for the given ISO week.
 * Uses `matched_at` timestamps on track_matches to determine "this week's" papers.
 *
 * @param db     Open database handle
 * @param weekIso  ISO week string, e.g. "2026-W08"
 * @param opts.maxTopPapers  Max papers to include in topPapers (default 5)
 */
export function getWeeklySummary(
  db: Db,
  weekIso: string,
  opts: { maxTopPapers?: number } = {}
): WeeklySummary {
  const { maxTopPapers = 5 } = opts;
  const { start, end } = weekDateRange(weekIso);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // ── Track breakdown ─────────────────────────────────────────────────────────
  const trackRows = db.sqlite.prepare(
    `SELECT
       tm.track_name        AS trackName,
       COUNT(DISTINCT tm.arxiv_id) AS count,
       MAX(tm.score)        AS topKeywordScore,
       MAX(ls.relevance_score) AS topLlmScore
     FROM track_matches tm
     LEFT JOIN llm_scores ls ON ls.arxiv_id = tm.arxiv_id
     WHERE tm.matched_at >= ? AND tm.matched_at <= ?
     GROUP BY tm.track_name
     ORDER BY COUNT(DISTINCT tm.arxiv_id) DESC, MAX(tm.score) DESC`
  ).all(startIso, endIso) as TrackCountRow[];

  // ── Total unique papers ─────────────────────────────────────────────────────
  const totalRow = db.sqlite.prepare(
    `SELECT COUNT(DISTINCT arxiv_id) AS total
     FROM track_matches
     WHERE matched_at >= ? AND matched_at <= ?`
  ).get(startIso, endIso) as { total: number };
  const totalPapers = totalRow?.total ?? 0;

  // ── Top papers ──────────────────────────────────────────────────────────────
  // Primary sort: LLM score DESC (nulls last), secondary: keyword score DESC
  const topRows = db.sqlite.prepare(
    `SELECT
       p.arxiv_id           AS arxivId,
       p.title              AS title,
       ls.relevance_score   AS llmScore,
       MAX(tm.score)        AS keywordScore,
       GROUP_CONCAT(DISTINCT tm.track_name) AS tracksConcat,
       p.meta_path          AS metaPath
     FROM track_matches tm
     JOIN papers p ON p.arxiv_id = tm.arxiv_id
     LEFT JOIN llm_scores ls ON ls.arxiv_id = tm.arxiv_id
     WHERE tm.matched_at >= ? AND tm.matched_at <= ?
     GROUP BY p.arxiv_id
     ORDER BY
       CASE WHEN ls.relevance_score IS NULL THEN 1 ELSE 0 END ASC,
       ls.relevance_score DESC,
       MAX(tm.score) DESC
     LIMIT ?`
  ).all(startIso, endIso, maxTopPapers) as TopPaperRow[];

  // Resolve absUrl from meta_path
  const topPapers: TopPaper[] = topRows.map(r => {
    let absUrl: string | null = null;
    try {
      const meta = JSON.parse(readFileSync(r.metaPath, 'utf8')) as { absUrl?: string };
      absUrl = meta.absUrl ?? null;
    } catch { /* ignore */ }

    return {
      arxivId: r.arxivId,
      title: r.title,
      llmScore: r.llmScore ?? null,
      keywordScore: r.keywordScore,
      tracks: r.tracksConcat ? r.tracksConcat.split(',') : [],
      absUrl,
    };
  });

  // ── Deep dive status ────────────────────────────────────────────────────────
  const sentRow = db.sqlite.prepare(
    `SELECT week_iso AS weekIso, arxiv_id AS arxivId
     FROM sent_weekly_digests
     WHERE week_iso = ?`
  ).get(weekIso) as SentWeeklyRow | undefined;

  let deepDive: DeepDiveStatus;
  if (sentRow) {
    // Look up the title for the sent paper
    const titleRow = db.sqlite.prepare(
      `SELECT title FROM papers WHERE arxiv_id = ?`
    ).get(sentRow.arxivId) as { title: string } | undefined;

    deepDive = {
      sent: true,
      arxivId: sentRow.arxivId,
      title: titleRow?.title ?? null,
    };
  } else {
    deepDive = { sent: false, arxivId: null, title: null };
  }

  // ── Assemble result ─────────────────────────────────────────────────────────
  const trackStats: TrackStat[] = trackRows.map(r => ({
    trackName: r.trackName,
    count: r.count,
    topKeywordScore: r.topKeywordScore,
    topLlmScore: r.topLlmScore ?? null,
  }));

  return {
    kind: 'weeklySummary',
    weekIso,
    dateRange: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    },
    totalPapers,
    trackStats,
    topPapers,
    deepDive,
  };
}
