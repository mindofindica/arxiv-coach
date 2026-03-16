/**
 * hot-paper.ts — Detect and format instant alerts for high-scoring papers.
 *
 * When the daily pipeline scores a paper above `threshold` in any track,
 * this module identifies papers that haven't been alerted yet and returns
 * formatted Signal/Telegram messages for them.
 *
 * Architecture:
 * - `findNewHotPapers()` — queries track_matches for high scorers not yet in hot_alerts
 * - `recordHotAlerts()` — marks papers as alerted (idempotent upsert)
 * - `formatHotAlertMessage()` — formats a single hot paper message
 * - `formatHotAlertBatch()` — formats a batch summary (when multiple hot papers found)
 *
 * Scoring note: arxiv-coach uses keyword-based scoring (0–12+):
 *   phrase match = +3, keyword match = +1
 *   Typical range: 3–12; scores ≥8 are genuinely exceptional (top ~5%)
 */

import type { Db } from '../db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HotPaperRecord {
  arxivId: string;
  trackName: string;
  score: number;
  title: string;
  authors: string;
  abstract: string;
  publishedAt: string;
  absUrl: string;
  matchedTerms: string[];
}

export interface HotAlertResult {
  papers: HotPaperRecord[];
  messages: string[];
  totalFound: number;
}

export interface FindHotPapersOptions {
  /** Minimum match score to qualify as a hot paper (default: 8) */
  threshold?: number;
  /** Only alert for papers discovered within the last N days (default: 3) */
  windowDays?: number;
  /** Maximum papers to alert per run to avoid spam (default: 5) */
  maxPerRun?: number;
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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function arxivAbsUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId}`;
}

function scoreBar(score: number, maxVisible = 12): string {
  // Each ● = 1 point, max 12 displayed
  const filled = Math.min(score, maxVisible);
  return '●'.repeat(filled) + '○'.repeat(Math.max(0, 5 - filled));
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Find papers in track_matches that score above threshold and haven't been
 * recorded in hot_alerts yet. Results are sorted by score DESC then matched_at DESC.
 */
export function findNewHotPapers(
  db: Db,
  opts: FindHotPapersOptions = {}
): HotPaperRecord[] {
  const {
    threshold = 8,
    windowDays = 3,
    maxPerRun = 5,
  } = opts;

  const windowCutoff = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = db.sqlite
    .prepare(
      `SELECT
         tm.arxiv_id,
         tm.track_name,
         tm.score,
         tm.matched_terms_json,
         p.title,
         p.authors_json,
         p.abstract,
         p.published_at
       FROM track_matches tm
       JOIN papers p ON p.arxiv_id = tm.arxiv_id
       LEFT JOIN hot_alerts ha
         ON ha.arxiv_id = tm.arxiv_id AND ha.track_name = tm.track_name
       WHERE tm.score >= ?
         AND tm.matched_at >= ?
         AND ha.arxiv_id IS NULL
       ORDER BY tm.score DESC, tm.matched_at DESC
       LIMIT ?`
    )
    .all(threshold, windowCutoff, maxPerRun) as Array<{
      arxiv_id: string;
      track_name: string;
      score: number;
      matched_terms_json: string;
      title: string;
      authors_json: string;
      abstract: string;
      published_at: string;
    }>;

  return rows.map((r) => ({
    arxivId: r.arxiv_id,
    trackName: r.track_name,
    score: r.score,
    title: r.title,
    authors: formatAuthors(r.authors_json),
    abstract: r.abstract,
    publishedAt: r.published_at,
    absUrl: arxivAbsUrl(r.arxiv_id),
    matchedTerms: (() => {
      try { return JSON.parse(r.matched_terms_json) as string[]; }
      catch { return []; }
    })(),
  }));
}

/**
 * Record that we've sent hot alerts for the given papers.
 * Uses INSERT OR REPLACE so it's idempotent.
 */
export function recordHotAlerts(
  db: Db,
  papers: Pick<HotPaperRecord, 'arxivId' | 'trackName' | 'score'>[]
): void {
  const stmt = db.sqlite.prepare(
    `INSERT OR REPLACE INTO hot_alerts (arxiv_id, track_name, score, alerted_at)
     VALUES (?, ?, ?, datetime('now'))`
  );
  for (const p of papers) {
    stmt.run(p.arxivId, p.trackName, p.score);
  }
}

/**
 * Format a single hot paper as a Telegram/Signal message.
 *
 * Example output:
 *   🔥 Hot paper in *Agent Evaluation & Reliability* (scored 9)
 *   *Self-Calibrating Multi-Agent Systems for Complex Reasoning*
 *   by Zhang et al. · 2026-03-15
 *
 *   Multi-agent frameworks that self-calibrate trust scores between agents...
 *
 *   Matched: planning, tool use, calibration, multi-agent
 *   https://arxiv.org/abs/2603.12345
 */
export function formatHotAlertMessage(paper: HotPaperRecord): string {
  const lines: string[] = [];

  lines.push(`🔥 *Hot paper in ${paper.trackName}* (score: ${paper.score})`);
  lines.push(`*${paper.title}*`);

  const pubDate = paper.publishedAt.slice(0, 10);
  lines.push(`by ${paper.authors} · ${pubDate}`);
  lines.push('');

  const excerpt = truncate(paper.abstract, 280);
  lines.push(excerpt);
  lines.push('');

  if (paper.matchedTerms.length > 0) {
    lines.push(`Matched: ${paper.matchedTerms.slice(0, 6).join(', ')}`);
  }
  lines.push(paper.absUrl);

  return lines.join('\n');
}

/**
 * Format a compact batch header when multiple hot papers are found.
 * Used as a summary before sending individual paper messages.
 */
export function formatHotAlertBatchHeader(papers: HotPaperRecord[]): string {
  if (papers.length === 0) return '';
  if (papers.length === 1) return ''; // single paper — no header needed, just the paper message

  const trackCounts = new Map<string, number>();
  for (const p of papers) {
    trackCounts.set(p.trackName, (trackCounts.get(p.trackName) ?? 0) + 1);
  }

  const trackSummary = [...trackCounts.entries()]
    .map(([track, count]) => `${count} in ${track}`)
    .join(', ');

  return `🔥 *${papers.length} high-scoring papers just dropped!*\n(${trackSummary})`;
}

/**
 * Main entry point: find new hot papers, format messages, record alerts.
 * Returns the result without side effects if `dryRun` is true.
 */
export function processHotAlerts(
  db: Db,
  opts: FindHotPapersOptions & { dryRun?: boolean } = {}
): HotAlertResult {
  const { dryRun = false, ...findOpts } = opts;

  const papers = findNewHotPapers(db, findOpts);

  if (papers.length === 0) {
    return { papers: [], messages: [], totalFound: 0 };
  }

  const messages: string[] = [];

  const batchHeader = formatHotAlertBatchHeader(papers);
  if (batchHeader) {
    messages.push(batchHeader);
  }

  for (const paper of papers) {
    messages.push(formatHotAlertMessage(paper));
  }

  if (!dryRun) {
    recordHotAlerts(db, papers);
  }

  return { papers, messages, totalFound: papers.length };
}
