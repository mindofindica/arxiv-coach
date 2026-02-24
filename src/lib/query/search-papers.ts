/**
 * search-papers — FTS5-backed paper search for arxiv-coach
 *
 * Queries the papers_fts virtual table (created in db.ts v7 migration)
 * and joins with llm_scores + track_matches for rich output.
 *
 * Usage:
 *   const results = searchPapers(db, 'speculative decoding');
 *   const results = searchPapers(db, 'RAG', { limit: 3, minLlmScore: 4 });
 *   const results = searchPapers(db, 'quantization', { track: 'LLM Efficiency' });
 */

import type { Db } from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  arxivId: string;
  title: string;
  /** First 200 characters of the abstract */
  excerpt: string;
  publishedAt: string;
  /** LLM relevance score 1–5, or null if not scored */
  llmScore: number | null;
  /** LLM reasoning text, or null */
  llmReasoning: string | null;
  /** Highest keyword/track match score */
  keywordScore: number;
  /** Track names this paper matched */
  tracks: string[];
  /** arXiv abstract URL */
  absUrl: string;
}

export interface SearchResponse {
  kind: 'searchResults';
  query: string;
  /** Number of results returned (may be less than total matches) */
  count: number;
  results: SearchResult[];
}

// ─── Internal row types ───────────────────────────────────────────────────────

interface SearchRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  published_at: string;
  llm_score: number | null;
  llm_reasoning: string | null;
  keyword_score: number;
  tracks_concat: string | null;
}

// ─── Query building ───────────────────────────────────────────────────────────

/**
 * Escape FTS5 special characters in a user-supplied query string.
 * Wraps each token in double quotes for phrase-safe matching.
 * Falls back to simple AND-join of tokens.
 */
function buildFtsQuery(rawQuery: string): string {
  // Split on whitespace, strip non-alphanumeric chars, filter empties
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/[^a-zA-Z0-9\-]/g, ''))
    .filter(t => t.length >= 2);

  if (tokens.length === 0) return rawQuery.trim();

  // Wrap each token to prevent FTS5 syntax injection
  return tokens.map(t => `"${t}"`).join(' ');
}

// ─── Main search function ─────────────────────────────────────────────────────

export interface SearchOptions {
  /** Max results to return (1–20, default 5) */
  limit?: number;
  /** Only return papers with llm_score >= this value */
  minLlmScore?: number;
  /** Filter to papers that matched at least one track containing this string (case-insensitive) */
  track?: string | null;
}

/**
 * Search papers using FTS5 full-text search over title + abstract.
 *
 * Results are ordered by:
 *   1. LLM score DESC (if scored)
 *   2. Keyword score DESC
 *   3. FTS5 bm25 rank (relevance)
 *
 * @param db      Open database connection
 * @param query   Free-text search query (e.g. "speculative decoding")
 * @param opts    Optional filters
 */
export function searchPapers(db: Db, query: string, opts: SearchOptions = {}): SearchResponse {
  const { limit = 5, minLlmScore, track } = opts;
  const clampedLimit = Math.min(Math.max(1, limit), 20);

  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return { kind: 'searchResults', query: trimmedQuery, count: 0, results: [] };
  }

  const ftsQuery = buildFtsQuery(trimmedQuery);

  // Build the main SQL query
  // - papers_fts MATCH finds relevant papers
  // - LEFT JOIN llm_scores for relevance score
  // - LEFT JOIN track_matches (aggregated) for keyword score + track names
  // - ORDER: llm_score DESC NULLS LAST, keyword_score DESC, rank (bm25, lower=better)
  let sql = `
    SELECT
      p.arxiv_id,
      p.title,
      p.abstract,
      p.published_at,
      ls.relevance_score   AS llm_score,
      ls.reasoning         AS llm_reasoning,
      COALESCE(MAX(tm.score), 0) AS keyword_score,
      GROUP_CONCAT(tm.track_name, '|') AS tracks_concat
    FROM papers_fts fts
    JOIN papers p ON p.arxiv_id = fts.arxiv_id
    LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
    LEFT JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
    WHERE papers_fts MATCH ?
  `;

  const params: (string | number)[] = [ftsQuery];

  if (typeof minLlmScore === 'number') {
    sql += ` AND ls.relevance_score >= ?`;
    params.push(minLlmScore);
  }

  if (track) {
    sql += ` AND tm.track_name LIKE ?`;
    params.push(`%${track}%`);
  }

  sql += `
    GROUP BY p.arxiv_id
    ORDER BY
      ls.relevance_score DESC,
      keyword_score DESC,
      rank
    LIMIT ?
  `;
  params.push(clampedLimit);

  let rows: SearchRow[];
  try {
    rows = db.sqlite.prepare(sql).all(...params) as SearchRow[];
  } catch {
    // FTS5 may throw if query is malformed; retry with a simpler form
    const fallbackQuery = trimmedQuery.replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
    if (!fallbackQuery) {
      return { kind: 'searchResults', query: trimmedQuery, count: 0, results: [] };
    }
    try {
      rows = db.sqlite.prepare(sql).all(fallbackQuery, ...params.slice(1)) as SearchRow[];
    } catch {
      return { kind: 'searchResults', query: trimmedQuery, count: 0, results: [] };
    }
  }

  const results: SearchResult[] = rows.map(row => ({
    arxivId: row.arxiv_id,
    title: row.title,
    excerpt: row.abstract.slice(0, 200).trimEnd() + (row.abstract.length > 200 ? '…' : ''),
    publishedAt: row.published_at,
    llmScore: row.llm_score ?? null,
    llmReasoning: row.llm_reasoning ?? null,
    keywordScore: row.keyword_score,
    tracks: row.tracks_concat ? row.tracks_concat.split('|').filter(Boolean) : [],
    absUrl: `https://arxiv.org/abs/${row.arxiv_id}`,
  }));

  return {
    kind: 'searchResults',
    query: trimmedQuery,
    count: results.length,
    results,
  };
}
