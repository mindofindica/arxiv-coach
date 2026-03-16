/**
 * hottest.ts — Query and format the top-scoring papers from the last N days.
 *
 * Powers the /hottest Signal command: "what have been the best papers
 * this week across all my tracks?"
 *
 * Design decisions:
 * - Default: unique papers (best score per arxiv_id, best track wins ties)
 * - dedup=false: show per-(arxiv_id, track) results (e.g. a paper that
 *   scored 11 in "LLM Agents" AND 9 in "AI Safety" appears twice)
 * - Results are ordered by score DESC, then published_at DESC
 * - windowDays defaults to 7 (one week lookback on matched_at)
 *
 * Scoring reference:
 *   keyword match = +1, phrase match = +3
 *   Typical range: 3–12. Scores ≥8 are exceptional (top ~5%)
 */

import type { Db } from '../db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HottestOptions {
  /** Look-back window in days (default: 7) */
  windowDays?: number;
  /** Maximum papers to return (default: 5, max: 20) */
  limit?: number;
  /** Minimum score to include (default: 1) */
  minScore?: number;
  /**
   * When true (default), deduplicate by arxiv_id — show each paper once
   * using its highest score. When false, show per-(arxiv_id, track) rows.
   */
  dedup?: boolean;
  /** Optional track name filter (case-insensitive substring match) */
  track?: string | null;
}

export interface HottestPaper {
  arxivId: string;
  trackName: string;
  score: number;
  title: string;
  authors: string;
  publishedAt: string;
  absUrl: string;
  matchedTerms: string[];
  matchedAt: string;
}

export interface HottestResult {
  papers: HottestPaper[];
  totalFound: number;
  windowDays: number;
  limit: number;
  dedup: boolean;
  trackFilter: string | null;
}

// ── Internal DB row types ─────────────────────────────────────────────────────

interface RawRow {
  arxiv_id: string;
  track_name: string;
  score: number;
  matched_terms_json: string;
  matched_at: string;
  title: string;
  authors_json: string;
  abstract: string;
  published_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function arxivAbsUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId}`;
}

function parseMatchedTerms(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

/**
 * Format a relative window description: "last 7 days" / "last 24 hours"
 */
export function formatWindowLabel(windowDays: number): string {
  if (windowDays === 1) return 'last 24 hours';
  if (windowDays === 7) return 'last 7 days';
  if (windowDays === 14) return 'last 2 weeks';
  if (windowDays === 30) return 'last 30 days';
  return `last ${windowDays} days`;
}

// ── Core query ────────────────────────────────────────────────────────────────

/**
 * Query the DB for top-scoring papers matched in the last `windowDays` days.
 *
 * When dedup=true: uses a subquery to find max score per arxiv_id, then
 * joins back to get the track that achieved that score (ties: earliest track).
 * When dedup=false: returns raw per-(arxiv_id, track) rows.
 */
export function queryHottestPapers(db: Db, opts: HottestOptions = {}): HottestPaper[] {
  const {
    windowDays = 7,
    limit = 5,
    minScore = 1,
    dedup = true,
    track = null,
  } = opts;

  const safLimit = Math.min(Math.max(1, limit), 20);
  const windowCutoff = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000
  ).toISOString();

  let rows: RawRow[];

  if (dedup) {
    // Per-paper: find max score, pick the track that achieved it
    const trackClause = track ? `AND LOWER(tm.track_name) LIKE ?` : '';
    const params: (string | number)[] = [windowCutoff, minScore];
    if (track) params.push(`%${track.toLowerCase()}%`);
    params.push(windowCutoff, minScore);
    if (track) params.push(`%${track.toLowerCase()}%`);
    params.push(safLimit);

    rows = db.sqlite.prepare(`
      SELECT
        tm.arxiv_id,
        tm.track_name,
        tm.score,
        tm.matched_terms_json,
        tm.matched_at,
        p.title,
        p.authors_json,
        p.abstract,
        p.published_at
      FROM track_matches tm
      JOIN papers p ON p.arxiv_id = tm.arxiv_id
      WHERE tm.matched_at >= ?
        AND tm.score >= ?
        ${trackClause}
        AND (tm.arxiv_id, tm.score) IN (
          SELECT arxiv_id, MAX(score)
          FROM track_matches
          WHERE matched_at >= ?
            AND score >= ?
            ${track ? trackClause : ''}
          GROUP BY arxiv_id
        )
      GROUP BY tm.arxiv_id
      ORDER BY tm.score DESC, p.published_at DESC
      LIMIT ?
    `).all(...params) as RawRow[];
  } else {
    // Per-track: one row per (arxiv_id, track) pair
    const trackClause = track ? `AND LOWER(tm.track_name) LIKE ?` : '';
    const params: (string | number)[] = [windowCutoff, minScore];
    if (track) params.push(`%${track.toLowerCase()}%`);
    params.push(safLimit);

    rows = db.sqlite.prepare(`
      SELECT
        tm.arxiv_id,
        tm.track_name,
        tm.score,
        tm.matched_terms_json,
        tm.matched_at,
        p.title,
        p.authors_json,
        p.abstract,
        p.published_at
      FROM track_matches tm
      JOIN papers p ON p.arxiv_id = tm.arxiv_id
      WHERE tm.matched_at >= ?
        AND tm.score >= ?
        ${trackClause}
      ORDER BY tm.score DESC, p.published_at DESC
      LIMIT ?
    `).all(...params) as RawRow[];
  }

  return rows.map((r) => ({
    arxivId: r.arxiv_id,
    trackName: r.track_name,
    score: r.score,
    title: r.title,
    authors: formatAuthors(r.authors_json),
    publishedAt: r.published_at,
    absUrl: arxivAbsUrl(r.arxiv_id),
    matchedTerms: parseMatchedTerms(r.matched_terms_json),
    matchedAt: r.matched_at,
  }));
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a single paper as a numbered list item.
 *
 * Example:
 *   1. Score 11 · LLM Agent Architecture
 *      Self-Calibrating Multi-Agent Systems for Complex Reasoning
 *      Zhang et al. · 2026-03-14
 *      Matched: planning, tool use, calibration
 *      https://arxiv.org/abs/2603.12345
 */
export function formatHottestPaperItem(paper: HottestPaper, index: number): string {
  const lines: string[] = [];

  const scoreStars = paper.score >= 10 ? '🌟' : paper.score >= 8 ? '⭐' : '✨';
  const pubDate = paper.publishedAt.slice(0, 10);

  lines.push(`${index + 1}. ${scoreStars} Score ${paper.score} · ${paper.trackName}`);
  lines.push(`   *${paper.title}*`);
  lines.push(`   ${paper.authors} · ${pubDate}`);

  if (paper.matchedTerms.length > 0) {
    const terms = paper.matchedTerms.slice(0, 5).join(', ');
    lines.push(`   Matched: ${terms}`);
  }

  lines.push(`   ${paper.absUrl}`);

  return lines.join('\n');
}

/**
 * Format the full /hottest reply message for Signal/Telegram.
 *
 * Example:
 *   🏆 *Top 5 papers — last 7 days*
 *
 *   1. 🌟 Score 11 · LLM Agent Architecture
 *      ...
 *
 *   2. ⭐ Score 9 · AI Safety & Alignment
 *      ...
 */
export function formatHottestReply(result: HottestResult): string {
  if (result.papers.length === 0) {
    const windowLabel = formatWindowLabel(result.windowDays);
    const trackNote = result.trackFilter ? ` in *${result.trackFilter}*` : '';
    return `🏆 *No papers found${trackNote} — ${windowLabel}*\n\nTry a wider window with \`--days 14\`.`;
  }

  const lines: string[] = [];
  const windowLabel = formatWindowLabel(result.windowDays);
  const trackNote = result.trackFilter ? ` — ${result.trackFilter}` : '';
  const count = result.papers.length;
  const truncNote = result.totalFound > count ? ` (showing ${count} of ${result.totalFound})` : '';

  lines.push(`🏆 *Top ${count} papers${trackNote} — ${windowLabel}*${truncNote}`);
  lines.push('');

  for (let i = 0; i < result.papers.length; i++) {
    lines.push(formatHottestPaperItem(result.papers[i]!, i));
    if (i < result.papers.length - 1) lines.push('');
  }

  return lines.join('\n');
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the full /hottest query + format pipeline.
 * Returns both the structured result and the formatted Signal reply.
 */
export function getHottestPapers(
  db: Db,
  opts: HottestOptions = {}
): HottestResult & { reply: string } {
  const {
    windowDays = 7,
    limit = 5,
    minScore = 1,
    dedup = true,
    track = null,
  } = opts;

  const papers = queryHottestPapers(db, opts);

  const result: HottestResult = {
    papers,
    totalFound: papers.length,
    windowDays,
    limit,
    dedup,
    trackFilter: track ?? null,
  };

  return {
    ...result,
    reply: formatHottestReply(result),
  };
}
