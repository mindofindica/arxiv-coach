/**
 * ondemand-digest.ts — On-demand digest runner for the /digest Signal command.
 *
 * Queries the local paper DB for matching papers and returns a formatted
 * Signal reply, bypassing the normal dedup window so users can pull a
 * fresh digest at any time (e.g. after a busy week or to test new tracks).
 *
 * Key differences from the scheduled daily runner:
 *  - dedupDays is 0 by default (or 1 if opts.respectDedup = true)
 *  - Accepts an optional track filter to narrow results to one track
 *  - Returns a single consolidated Signal message (not per-track messages)
 *  - Caps at a lower paper count to keep the reply scannable on mobile
 */

import type { Db } from '../db.js';
import { truncateForSignal } from '../digest/truncate.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface OnDemandDigestOptions {
  /**
   * Optional track name filter (case-insensitive substring match).
   * When omitted, all tracks are included.
   */
  track?: string | null;

  /**
   * Maximum number of papers to return across all tracks.
   * Default: 10.
   */
  limit?: number;

  /**
   * When true, exclude papers sent within the last 24 hours.
   * Default: false (bypass dedup entirely for on-demand use).
   */
  respectDedup?: boolean;

  /**
   * Minimum LLM relevance score (1–5) to include.
   * Default: 3 (consistent with scheduled digest noise filter).
   */
  minScore?: number;
}

export interface OnDemandPaper {
  arxivId: string;
  title: string;
  abstract: string;
  absUrl: string | null;
  score: number;
  llmScore: number | null;
  matchedTerms: string[];
  trackName: string;
}

export interface OnDemandDigestResult {
  papers: OnDemandPaper[];
  totalFound: number;
  trackFilter: string | null;
  truncated: boolean;
  reply: string;
}

// ── DB query ───────────────────────────────────────────────────────────────

interface RawRow {
  arxivId: string;
  title: string;
  abstract: string;
  metaPath: string;
  score: number;
  matchedTermsJson: string;
  trackName: string;
  llmScore: number | null;
}

/**
 * Fetch candidate papers from the DB, ordered by relevance.
 * Applies optional track filter and dedup window.
 */
export function fetchOnDemandPapers(
  db: Db,
  opts: OnDemandDigestOptions = {},
): OnDemandPaper[] {
  const {
    track = null,
    limit = 10,
    respectDedup = false,
    minScore = 3,
  } = opts;

  const dedupDays = respectDedup ? 1 : 0;
  const effectiveLimit = Math.min(Math.max(1, limit), 20);

  const dedupClause =
    dedupDays > 0
      ? `AND NOT EXISTS (
           SELECT 1 FROM digest_papers dp
           WHERE dp.arxiv_id = p.arxiv_id
             AND dp.digest_date >= date('now', '-${dedupDays} days')
         )`
      : '';

  // Track filter: case-insensitive substring match on track_name
  const trackClause = track ? `AND LOWER(tm.track_name) LIKE LOWER(?)` : '';

  const sql = `
    SELECT
      tm.track_name        AS trackName,
      tm.score             AS score,
      tm.matched_terms_json AS matchedTermsJson,
      p.arxiv_id           AS arxivId,
      p.title              AS title,
      p.abstract           AS abstract,
      p.meta_path          AS metaPath,
      ls.relevance_score   AS llmScore
    FROM track_matches tm
    JOIN papers p ON p.arxiv_id = tm.arxiv_id
    LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
    WHERE 1=1
      ${dedupClause}
      ${trackClause}
    ORDER BY
      CASE WHEN ls.relevance_score IS NOT NULL THEN 0 ELSE 1 END,
      COALESCE(ls.relevance_score, 0) DESC,
      tm.score DESC,
      tm.matched_at DESC
    LIMIT ?
  `;

  const params: (string | number)[] = [];
  if (track) params.push(`%${track}%`);
  params.push(effectiveLimit * 3); // over-fetch, then filter by minScore

  const rows = db.sqlite.prepare(sql).all(...params) as RawRow[];

  const papers: OnDemandPaper[] = [];
  for (const r of rows) {
    if (papers.length >= effectiveLimit) break;

    // Apply LLM score floor
    if (r.llmScore !== null && r.llmScore < minScore) continue;

    // Build abs URL from arxiv_id (meta_path fallback)
    let absUrl: string | null = `https://arxiv.org/abs/${r.arxivId}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      const meta = JSON.parse(fs.readFileSync(r.metaPath, 'utf8')) as {
        absUrl?: string;
      };
      if (meta.absUrl) absUrl = meta.absUrl;
    } catch {
      // keep fallback
    }

    papers.push({
      arxivId: r.arxivId,
      title: r.title,
      abstract: r.abstract,
      absUrl,
      score: r.score,
      llmScore: r.llmScore ?? null,
      matchedTerms: safeJsonArray(r.matchedTermsJson),
      trackName: r.trackName,
    });
  }

  return papers;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function snippet(text: string, maxLen = 200): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
}

/**
 * Render papers into a Signal-friendly digest message.
 */
export function renderOnDemandReply(
  papers: OnDemandPaper[],
  trackFilter: string | null,
): { text: string; truncated: boolean } {
  if (papers.length === 0) {
    const trackLabel = trackFilter ? ` for "${trackFilter}"` : '';
    const text = [
      `📭 No papers found${trackLabel}.`,
      '',
      'Try broadening your track filter or run /status to check the pipeline.',
    ].join('\n');
    return { text, truncated: false };
  }

  const trackLabel = trackFilter ? ` — ${trackFilter}` : '';
  const lines: string[] = [`📬 On-demand digest${trackLabel} (${papers.length} papers)`];
  lines.push('');

  // Group by track for readability
  const byTrack = new Map<string, OnDemandPaper[]>();
  for (const p of papers) {
    if (!byTrack.has(p.trackName)) byTrack.set(p.trackName, []);
    byTrack.get(p.trackName)!.push(p);
  }

  for (const [track, trackPapers] of byTrack) {
    if (byTrack.size > 1) {
      lines.push(`▸ ${track}`);
    }
    for (const p of trackPapers) {
      lines.push(`• ${p.title}`);
      if (p.absUrl) lines.push(`  ${p.absUrl}`);
      const meta: string[] = [];
      if (p.llmScore !== null) meta.push(`relevance: ${p.llmScore}/5`);
      if (p.matchedTerms.length) meta.push(`matched: ${p.matchedTerms.join(', ')}`);
      if (meta.length) lines.push(`  ${meta.join(' • ')}`);
      lines.push(`  ${snippet(p.abstract)}`);
      lines.push('');
    }
  }

  lines.push('Use /read /save /love <arxiv-id> to give feedback.');

  return truncateForSignal(lines.join('\n').trim());
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run an on-demand digest and return a structured result with reply text.
 */
export function runOnDemandDigest(
  db: Db,
  opts: OnDemandDigestOptions = {},
): OnDemandDigestResult {
  const { track = null, limit = 10 } = opts;

  const papers = fetchOnDemandPapers(db, opts);
  const totalFound = papers.length;
  const { text, truncated } = renderOnDemandReply(papers, track ?? null);

  return {
    papers,
    totalFound,
    trackFilter: track ?? null,
    truncated,
    reply: text,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function safeJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
