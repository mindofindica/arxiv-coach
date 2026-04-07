/**
 * hottest-papers.ts — Surface the highest-scoring papers from the last N days.
 *
 * Unlike the daily digest (which picks papers per-track with maxPerDay limits)
 * and hot-paper alerts (which fire once per paper when it's first ingested),
 * `/hottest` is an *on-demand* query: "what are the genuinely top papers from
 * the past week, deduped across tracks?"
 *
 * Dedup strategy:
 *   A paper can match multiple tracks. We GROUP BY arxiv_id and take
 *   MAX(score) as the canonical score, then order by that. The `tracks`
 *   field still shows all tracks the paper matched.
 *
 * Scoring reference (keyword-based, 0–12+):
 *   phrase match = +3, keyword match = +1
 *   Typical exceptional range: ≥8 (top ~5%)
 *
 * Score icons:
 *   🌟 score ≥ 10  — exceptional
 *   ⭐ score ≥  8  — very strong
 *   ✨ score  <  8  — notable
 */

import type { Db } from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HottestPaper {
  arxivId: string;
  title: string;
  /** Abstract text, possibly truncated */
  abstract: string;
  authors: string;
  publishedAt: string;
  /** Canonical score: MAX(score) across all matching tracks */
  score: number;
  /** All tracks this paper matched */
  tracks: string[];
  absUrl: string;
}

export interface HottestResult {
  kind: 'hottest';
  /** Days window used for the query */
  days: number;
  /** Track filter applied, or null for all tracks */
  track: string | null;
  /** Total deduplicated papers found before limit */
  totalFound: number;
  papers: HottestPaper[];
}

export interface HottestEmpty {
  kind: 'empty';
  days: number;
  track: string | null;
  message: string;
}

export type HottestOutput = HottestResult | HottestEmpty;

export interface HottestOptions {
  /** Look back this many days (default: 7) */
  days?: number;
  /** Filter to a specific track name (case-insensitive substring match) */
  track?: string | null;
  /** Maximum results to return (default: 5, max: 20) */
  limit?: number;
  /** Minimum score to include (default: 1 — include everything, sort handles the rest) */
  minScore?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Emoji icon for a given score.
 * 🌟 ≥10 | ⭐ ≥8 | ✨ <8
 */
export function scoreIcon(score: number): string {
  if (score >= 10) return '🌟';
  if (score >= 8) return '⭐';
  return '✨';
}

function formatAuthors(authorsJson: string): string {
  try {
    const arr: string[] = JSON.parse(authorsJson);
    if (arr.length === 0) return 'Unknown authors';
    if (arr.length === 1) return arr[0] ?? 'Unknown authors';
    if (arr.length <= 3) return arr.join(', ');
    return `${arr[0] ?? 'Unknown'} et al.`;
  } catch {
    return authorsJson ?? 'Unknown authors';
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function arxivAbsUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId}`;
}

// ─── DB row type ──────────────────────────────────────────────────────────────

interface HottestRow {
  arxivId: string;
  title: string;
  abstract: string;
  authorsJson: string;
  publishedAt: string;
  topScore: number;
  tracksConcat: string;
}

// ─── Core query ───────────────────────────────────────────────────────────────

/**
 * Query the database for the hottest (highest-scoring) papers from the last
 * `days` days. Papers are deduplicated by arxiv_id; each paper carries its
 * MAX(score) across all matching tracks.
 *
 * @param db     Open database handle
 * @param opts   Query options
 */
export function queryHottestPapers(
  db: Db,
  opts: HottestOptions = {}
): HottestOutput {
  const {
    days = 7,
    track = null,
    limit = 5,
    minScore = 1,
  } = opts;

  const safeDays = Math.max(1, Math.min(days, 90));
  const safeLimit = Math.max(1, Math.min(limit, 20));

  const cutoff = new Date(
    Date.now() - safeDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Build SQL — optionally filter by track name (case-insensitive substring)
  const trackFilter = track ? `AND LOWER(tm.track_name) LIKE LOWER(?)` : '';
  const params: unknown[] = track
    ? [cutoff, `%${track}%`, minScore, safeLimit]
    : [cutoff, minScore, safeLimit];

  const sql = `
    SELECT
      p.arxiv_id            AS arxivId,
      p.title               AS title,
      p.abstract            AS abstract,
      p.authors_json        AS authorsJson,
      p.published_at        AS publishedAt,
      MAX(tm.score)         AS topScore,
      GROUP_CONCAT(DISTINCT tm.track_name) AS tracksConcat
    FROM track_matches tm
    JOIN papers p ON p.arxiv_id = tm.arxiv_id
    WHERE tm.matched_at >= ?
      ${trackFilter}
    GROUP BY p.arxiv_id
    HAVING MAX(tm.score) >= ?
    ORDER BY MAX(tm.score) DESC, p.published_at DESC
    LIMIT ?
  `;

  // Count total matching papers (before limit)
  const countSql = `
    SELECT COUNT(DISTINCT tm.arxiv_id) AS total
    FROM track_matches tm
    WHERE tm.matched_at >= ?
      ${trackFilter}
      AND tm.score >= ?
  `;
  const countParams: unknown[] = track
    ? [cutoff, `%${track}%`, minScore]
    : [cutoff, minScore];

  const countRow = db.sqlite.prepare(countSql).get(...(countParams as [unknown, ...unknown[]])) as
    | { total: number }
    | undefined;
  const totalFound = countRow?.total ?? 0;

  if (totalFound === 0) {
    const trackMsg = track ? ` in track matching "${track}"` : '';
    return {
      kind: 'empty',
      days: safeDays,
      track,
      message: `No papers found${trackMsg} in the last ${safeDays} day${safeDays === 1 ? '' : 's'} with score ≥ ${minScore}.`,
    };
  }

  const rows = db.sqlite.prepare(sql).all(...(params as [unknown, ...unknown[]])) as HottestRow[];

  const papers: HottestPaper[] = rows.map(r => ({
    arxivId: r.arxivId,
    title: r.title,
    abstract: truncate(r.abstract ?? '', 300),
    authors: formatAuthors(r.authorsJson),
    publishedAt: r.publishedAt,
    score: r.topScore,
    tracks: r.tracksConcat ? r.tracksConcat.split(',') : [],
    absUrl: arxivAbsUrl(r.arxivId),
  }));

  return {
    kind: 'hottest',
    days: safeDays,
    track,
    totalFound,
    papers,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a HottestResult as a Signal/Telegram message.
 *
 * Example output:
 *   🔥 *Hottest papers — last 7 days* (top 3 of 42)
 *
 *   🌟 *Self-Calibrating Multi-Agent Systems* (score: 11)
 *   Agent Evaluation, Multi-Agent · Zhang et al. · 2026-03-19
 *   Agents that adjust inter-agent trust scores at runtime…
 *   https://arxiv.org/abs/2603.12345
 *
 *   ⭐ *Retrieval-Augmented Chain-of-Thought* (score: 9)
 *   ...
 */
export function formatHottestMessage(result: HottestResult): string {
  const lines: string[] = [];

  const headerTrack = result.track ? ` · ${result.track}` : '';
  const showing = result.papers.length;
  const total = result.totalFound;
  const countNote = total > showing ? `top ${showing} of ${total}` : `${showing} paper${showing === 1 ? '' : 's'}`;

  lines.push(`🔥 *Hottest papers — last ${result.days} day${result.days === 1 ? '' : 's'}${headerTrack}* (${countNote})`);

  for (const paper of result.papers) {
    lines.push('');
    const icon = scoreIcon(paper.score);
    lines.push(`${icon} *${paper.title}* (score: ${paper.score})`);

    const pubDate = paper.publishedAt.slice(0, 10);
    const trackList = paper.tracks.join(', ');
    lines.push(`${trackList} · ${paper.authors} · ${pubDate}`);
    lines.push(paper.abstract);
    lines.push(paper.absUrl);
  }

  return lines.join('\n');
}

/**
 * Format the empty/no-results case.
 */
export function formatHottestEmpty(result: HottestEmpty): string {
  return `📭 ${result.message}`;
}

/**
 * Convenience: format any HottestOutput.
 */
export function formatHottest(output: HottestOutput): string {
  if (output.kind === 'empty') return formatHottestEmpty(output);
  return formatHottestMessage(output);
}
