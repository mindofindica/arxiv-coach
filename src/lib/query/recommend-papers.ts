/**
 * recommend-papers — personalised paper recommendations based on feedback signals
 *
 * Looks at papers the user has saved/loved (high priority in reading_list or
 * love feedback), extracts their key terms, and surfaces papers from the
 * corpus that haven't been shown in a digest yet.
 *
 * Usage:
 *   const res = recommendPapers(db);
 *   const res = recommendPapers(db, { limit: 3, track: 'RAG' });
 */

import type { Db } from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecommendResult {
  arxivId: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  llmScore: number | null;
  llmReasoning: string | null;
  tracks: string[];
  absUrl: string;
  /** Why this was recommended (for transparency) */
  matchedTerms: string[];
}

export interface RecommendResponse {
  kind: 'recommendations';
  /** Number of preference-signal papers used to build the query */
  signalCount: number;
  /** Top terms extracted from signal papers */
  keyTerms: string[];
  results: RecommendResult[];
}

export interface RecommendError {
  kind: 'noSignal' | 'noResults';
  message: string;
}

export type RecommendOutput = RecommendResponse | RecommendError;

export interface RecommendOptions {
  /** Max results to return (1–10, default 5) */
  limit?: number;
  /** Filter to a specific track */
  track?: string | null;
  /** Minimum priority threshold for reading_list papers (default: 7) */
  minPriority?: number;
}

// ─── Stop words ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
  'via', 'using', 'based', 'towards', 'toward', 'through', 'into',
  'over', 'under', 'up', 'new', 'large', 'large-scale', 'efficient',
  'approach', 'method', 'methods', 'model', 'models', 'system', 'systems',
  'paper', 'study', 'analysis', 'survey', 'framework', 'benchmark',
  'improving', 'improved', 'towards', 'beyond', 'without', 'across',
]);

// ─── Term extraction ──────────────────────────────────────────────────────────

/**
 * Extract meaningful single-word terms from a paper title.
 * Returns lowercase tokens with stop words removed.
 */
function extractTerms(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // keep hyphens (e.g. "chain-of-thought")
    .split(/\s+/)
    .map(t => t.replace(/^-+|-+$/g, ''))  // strip leading/trailing hyphens
    .filter(t => t.length >= 4 && !STOP_WORDS.has(t));
}

/**
 * Get the top-N most frequent terms from a set of paper titles.
 * Returns terms sorted by descending frequency, breaking ties alphabetically.
 */
export function topTermsFromTitles(titles: string[], topN = 12): string[] {
  const freq = new Map<string, number>();
  for (const title of titles) {
    for (const term of extractTerms(title)) {
      freq.set(term, (freq.get(term) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([term]) => term);
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface SignalRow {
  paper_id: string;
  title: string;
}

interface RecommendRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  published_at: string;
  llm_score: number | null;
  llm_reasoning: string | null;
  tracks_concat: string | null;
}

// ─── Main function ────────────────────────────────────────────────────────────

export function recommendPapers(
  db: Db,
  opts: RecommendOptions = {}
): RecommendOutput {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 10);
  const minPriority = opts.minPriority ?? 7;

  // 1. Collect signal papers — reading_list high-priority + /love feedback
  const signalRows = db.sqlite.prepare<[number], SignalRow>(`
    SELECT DISTINCT p.arxiv_id AS paper_id, p.title
    FROM papers p
    WHERE p.arxiv_id IN (
      -- High-priority reading list items
      SELECT paper_id FROM reading_list WHERE priority >= ?
      UNION
      -- Papers the user loved
      SELECT paper_id FROM paper_feedback WHERE feedback_type = 'love'
    )
    LIMIT 50
  `).all(minPriority);

  if (signalRows.length === 0) {
    return {
      kind: 'noSignal',
      message:
        'No preference signal yet. Use /love or /save on papers you enjoy ' +
        'and I\'ll learn your taste over time.',
    };
  }

  // 2. Extract key terms from signal paper titles
  const keyTerms = topTermsFromTitles(signalRows.map(r => r.title));
  if (keyTerms.length === 0) {
    return {
      kind: 'noSignal',
      message: 'Could not extract enough signal from your saved papers. Try /love more papers.',
    };
  }

  // 3. Build FTS query — OR semantics across all key terms
  //    We want papers matching ANY of these terms (union of interests).
  //    Use OR so we cast a wide net, then rank by llm_score.
  const ftsQuery = keyTerms.map(t => `"${t}"`).join(' OR ');

  // 4. Build the SQL query
  //    Filter out:
  //      - Papers already shown in any digest (digest_papers)
  //      - Papers already in the reading list
  //    Filter in (if track specified): papers matching that track
  const trackClause = opts.track
    ? `AND EXISTS (
         SELECT 1 FROM track_matches tm
         WHERE tm.arxiv_id = p.arxiv_id
           AND tm.track_name LIKE '%' || ? || '%'
       )`
    : '';

  const params: (string | number)[] = [ftsQuery];
  if (opts.track) params.push(opts.track);
  params.push(limit * 3); // fetch extra to have room after dedup filtering

  const rows = db.sqlite.prepare<(string | number)[], RecommendRow>(`
    SELECT
      p.arxiv_id,
      p.title,
      p.abstract,
      p.published_at,
      ls.relevance_score  AS llm_score,
      ls.reasoning        AS llm_reasoning,
      GROUP_CONCAT(DISTINCT tm.track_name) AS tracks_concat
    FROM papers_fts pf
    JOIN papers p ON p.arxiv_id = pf.arxiv_id
    LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
    LEFT JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
    WHERE papers_fts MATCH ?
      ${trackClause}
      -- Exclude papers already delivered in any digest
      AND p.arxiv_id NOT IN (
        SELECT arxiv_id FROM digest_papers
      )
      -- Exclude papers already in the reading list
      AND p.arxiv_id NOT IN (
        SELECT paper_id FROM reading_list
      )
    GROUP BY p.arxiv_id
    ORDER BY ls.relevance_score DESC NULLS LAST, pf.rank
    LIMIT ?
  `).all(...params);

  if (rows.length === 0) {
    return {
      kind: 'noResults',
      message:
        'All highly relevant papers have already been included in your digests. ' +
        'Try /search for specific topics or check back after the next digest.',
    };
  }

  const results: RecommendResult[] = rows.slice(0, limit).map(row => {
    const titleLower = row.title.toLowerCase();
    const matched = keyTerms.filter(t => titleLower.includes(t)).slice(0, 3);

    return {
      arxivId: row.arxiv_id,
      title: row.title,
      excerpt: row.abstract.slice(0, 200),
      publishedAt: row.published_at,
      llmScore: row.llm_score ?? null,
      llmReasoning: row.llm_reasoning ?? null,
      tracks: row.tracks_concat ? row.tracks_concat.split(',').filter(Boolean) : [],
      absUrl: `https://arxiv.org/abs/${row.arxiv_id}`,
      matchedTerms: matched,
    };
  });

  return {
    kind: 'recommendations',
    signalCount: signalRows.length,
    keyTerms: keyTerms.slice(0, 5), // show top-5 in message for transparency
    results,
  };
}
