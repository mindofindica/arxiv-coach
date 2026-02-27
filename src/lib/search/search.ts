/**
 * search — unified FTS5 paper search for arxiv-coach.
 *
 * Single source of truth for paper search, used by both the Signal handler
 * and the CLI query script.
 *
 * Exports:
 *   searchPapers(db, opts)  — core search function
 *   sanitiseQuery(raw)      — clean a user-supplied query string for FTS5
 *   formatSearchReply(resp) — compact Signal-ready plain-text formatter
 *   renderSearchMessage(resp) — richer Signal-ready formatter with excerpt + URL
 *   renderSearchCompact(resp) — one-liner summary for debug / logging
 *
 * Design:
 *   • Porter-stemmed FTS5 over title + abstract (via papers_fts virtual table)
 *   • Ranking: llm_score DESC → keyword_score DESC → FTS rank (best relevance first)
 *   • Optional filters: date window (from), LLM score threshold (minLlmScore),
 *     track name (track — applied post-FTS in JS)
 *   • Graceful degradation: FTS syntax errors return empty results, never throw
 *   • Signal-safe formatters: no markdown tables, titles truncated, tap-able IDs
 */

import { truncateForSignal } from '../digest/truncate.js';
import type { Db } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** FTS5 query string. Supports bare keywords (AND) or "phrase search". */
  query: string;
  /** Maximum results to return (1–20, default 5). */
  limit?: number;
  /**
   * ISO date prefix filter, e.g. "2026" or "2025-10".
   * Papers published before this prefix are excluded.
   */
  from?: string | null;
  /**
   * Track name filter. If set, only papers with a track_matches row whose
   * track_name contains this string (case-insensitive) are returned.
   * Applied post-FTS in JS to preserve all track names in results.
   */
  track?: string | null;
  /**
   * Minimum LLM relevance score (1–5). Papers with no score or a score below
   * this threshold are excluded. Applied in SQL for efficiency.
   */
  minLlmScore?: number | null;
}

export interface SearchResult {
  /** arXiv paper ID, e.g. "2501.12345". */
  arxivId: string;
  /** Full title. */
  title: string;
  /** ISO 8601 publication date. */
  publishedAt: string;
  /** Full abstract text. */
  abstract: string;
  /** First ~200 characters of the abstract (for compact display). */
  excerpt: string;
  /** Track names this paper matched (all tracks, regardless of filter). */
  tracks: string[];
  /** LLM relevance score (1–5), or null if not scored. */
  llmScore: number | null;
  /** LLM reasoning text, or null. */
  llmReasoning: string | null;
  /** Highest keyword/track match score (from track_matches.score). */
  keywordScore: number;
  /** arXiv abstract URL, e.g. "https://arxiv.org/abs/2501.12345". */
  absUrl: string;
}

export interface SearchResponse {
  /** Discriminant tag for pattern-matching. */
  kind: 'searchResults';
  /** Echo of the user's query. */
  query: string;
  /** Number of results in this response (≤ limit). */
  count: number;
  /**
   * Total FTS hits before the limit/track filter.
   * Useful for "showing X of Y" display.
   */
  totalCount: number;
  results: SearchResult[];
}

// ── Internal row types ─────────────────────────────────────────────────────────

interface FtsRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  published_at: string;
  llm_score: number | null;
  llm_reasoning: string | null;
  keyword_score: number;
  tracks_concat: string | null;
}

interface CountRow {
  n: number;
}

// ── Query sanitisation ─────────────────────────────────────────────────────────

/**
 * Sanitise a user query string for safe FTS5 use.
 *
 * Rules:
 *   - If the query is already wrapped in double-quotes → phrase search, pass through.
 *   - Otherwise, strip stray double-quotes (prevent FTS5 parse errors if unbalanced).
 *   - Convert hyphens to spaces: in FTS5 query syntax a leading `-` means NOT,
 *     so "high-quality" would parse as "high AND NOT quality". Converting to
 *     spaces gives "high quality" (AND semantics) — more natural for Signal input.
 *
 * Examples:
 *   sanitiseQuery('speculative decoding')   → 'speculative decoding'   (AND)
 *   sanitiseQuery('"LoRA fine-tuning"')     → '"LoRA fine-tuning"'     (phrase)
 *   sanitiseQuery('RAG "augmented"')        → 'RAG augmented'          (stripped)
 *   sanitiseQuery('high-quality')           → 'high quality'           (hyphen→space)
 */
export function sanitiseQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Already a valid phrase query — pass through
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    return trimmed;
  }
  return trimmed
    .replace(/"/g, '')   // strip stray double-quotes
    .replace(/-/g, ' ')  // hyphens → spaces (avoid FTS5 NOT operator)
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Core search ────────────────────────────────────────────────────────────────

/**
 * Run a full-text search over the papers corpus.
 *
 * Ranking order (best first):
 *   1. LLM relevance score DESC (papers Mikey found excellent bubble up)
 *   2. Keyword/track score DESC (higher keyword match score)
 *   3. FTS5 BM25 rank (most textually relevant)
 *
 * @param db    Open database connection
 * @param opts  Search options (query is required)
 */
export function searchPapers(db: Db, opts: SearchOptions): SearchResponse {
  const { query, limit = 5, from = null, track = null, minLlmScore = null } = opts;

  const safeQuery = sanitiseQuery(query);
  const empty: SearchResponse = { kind: 'searchResults', query, count: 0, totalCount: 0, results: [] };

  if (!safeQuery) return empty;

  const clampedLimit = Math.max(1, Math.min(20, limit));

  // ── Build SQL fragments based on active filters ──────────────────────────
  const whereClauses: string[] = ['papers_fts MATCH ?'];
  const params: (string | number)[] = [safeQuery];

  if (from) {
    whereClauses.push('p.published_at >= ?');
    params.push(from);
  }

  if (minLlmScore !== null && minLlmScore !== undefined) {
    whereClauses.push('ls.relevance_score >= ?');
    params.push(minLlmScore);
  }

  const whereStr = whereClauses.join('\n    AND ');

  // ── Count total hits (before limit / track filter) ───────────────────────
  let totalCount = 0;
  try {
    const countSql = `
      SELECT COUNT(DISTINCT p.arxiv_id) AS n
      FROM papers_fts fts
      JOIN papers p ON p.arxiv_id = fts.arxiv_id
      LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
      WHERE ${whereStr}
    `;
    const countRow = db.sqlite.prepare(countSql).get(...params) as CountRow | undefined;
    totalCount = countRow?.n ?? 0;
  } catch {
    return empty;
  }

  if (totalCount === 0) return { ...empty, query };

  // ── Fetch FTS results ────────────────────────────────────────────────────
  // Fetch extra results when track filtering so we have enough after the JS filter.
  const fetchLimit = track ? clampedLimit * 6 : clampedLimit;

  let ftsRows: FtsRow[];
  try {
    const fetchSql = `
      SELECT
        p.arxiv_id,
        p.title,
        p.abstract,
        p.published_at,
        ls.relevance_score             AS llm_score,
        ls.reasoning                   AS llm_reasoning,
        COALESCE(MAX(tm.score), 0)     AS keyword_score,
        GROUP_CONCAT(tm.track_name, '|') AS tracks_concat
      FROM papers_fts fts
      JOIN papers p ON p.arxiv_id = fts.arxiv_id
      LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
      LEFT JOIN track_matches tm ON tm.arxiv_id = p.arxiv_id
      WHERE ${whereStr}
      GROUP BY p.arxiv_id
      ORDER BY
        ls.relevance_score DESC,
        keyword_score DESC,
        rank
      LIMIT ?
    `;
    ftsRows = db.sqlite.prepare(fetchSql).all(...params, fetchLimit) as FtsRow[];
  } catch {
    // FTS syntax error — graceful fallback
    return { ...empty, query };
  }

  if (ftsRows.length === 0) return { ...empty, query, totalCount };

  // ── Assemble results with optional track filter ──────────────────────────
  const trackLower = track?.toLowerCase() ?? null;
  const results: SearchResult[] = [];

  for (const row of ftsRows) {
    if (results.length >= clampedLimit) break;

    const tracks = row.tracks_concat
      ? row.tracks_concat.split('|').filter(Boolean)
      : [];

    if (trackLower) {
      const hasTrack = tracks.some((t) => t.toLowerCase().includes(trackLower));
      if (!hasTrack) continue;
    }

    const abstract = row.abstract ?? '';
    const excerpt = abstract.length > 200
      ? abstract.slice(0, 200).trimEnd() + '…'
      : abstract;

    results.push({
      arxivId: row.arxiv_id,
      title: row.title,
      publishedAt: row.published_at,
      abstract,
      excerpt,
      tracks,
      llmScore: row.llm_score ?? null,
      llmReasoning: row.llm_reasoning ?? null,
      keywordScore: row.keyword_score,
      absUrl: `https://arxiv.org/abs/${row.arxiv_id}`,
    });
  }

  return {
    kind: 'searchResults',
    query,
    count: results.length,
    totalCount,
    results,
  };
}

// ── Signal formatters ──────────────────────────────────────────────────────────

/**
 * Format a search response as a compact plain-text Signal message.
 *
 * Used by the Signal handler for /search replies.
 *
 * Design constraints:
 *   - No markdown tables (Signal strips them)
 *   - Titles truncated to 65 chars (readable on mobile)
 *   - arxiv ID on its own line (tap-to-copy friendly)
 *   - Track badges in parentheses if present
 *   - LLM score (★N) when available
 *   - Footer command hints
 */
export function formatSearchReply(resp: SearchResponse): string {
  const { results, totalCount, query } = resp;

  if (results.length === 0) {
    return (
      `🔍 No results for "${query}"\n\n` +
      `Try different keywords, e.g.:\n` +
      `  /search speculative decoding\n` +
      `  /search "retrieval augmented generation"\n` +
      `  /search LoRA fine-tuning --limit 10`
    );
  }

  const showing = results.length;
  const header =
    totalCount > showing
      ? `🔍 "${query}" — ${showing} of ${totalCount}`
      : `🔍 "${query}" — ${showing} result${showing === 1 ? '' : 's'}`;

  const lines: string[] = [header, ''];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const num = i + 1;
    const title = r.title.length > 65 ? r.title.slice(0, 62) + '…' : r.title;
    const date = r.publishedAt.slice(0, 10);
    const trackBadge =
      r.tracks.length > 0 ? ` [${r.tracks.slice(0, 2).join(', ')}]` : '';
    const scoreBadge = r.llmScore !== null ? ` ★${r.llmScore}` : '';

    lines.push(`${num}. ${title}${trackBadge}${scoreBadge}`);
    lines.push(`   ${date} · arxiv:${r.arxivId}`);
  }

  lines.push('');
  lines.push('Commands: /save <id> · /read <id> · /love <id>');

  if (totalCount > showing) {
    lines.push(`More: /search ${query} --limit 10`);
  }

  return lines.join('\n');
}

// ── Richer formatter (CLI / query-search) ──────────────────────────────────────

/** Score emoji for LLM relevance score (1–5). */
function scoreEmoji(score: number | null): string {
  if (score === null) return '·';
  if (score >= 5) return '🔥';
  if (score >= 4) return '⭐';
  if (score >= 3) return '📌';
  return '·';
}

/** Format a single result as 4 lines for Signal. */
function formatResultRich(result: SearchResult, index: number): string[] {
  const lines: string[] = [];

  const scoreStr =
    result.llmScore !== null
      ? `${scoreEmoji(result.llmScore)} ${result.llmScore}/5`
      : result.keywordScore > 0
        ? `kw:${result.keywordScore}`
        : '·';

  const tracksStr =
    result.tracks.length > 0 ? result.tracks.slice(0, 2).join(', ') : 'untracked';

  const shortExcerpt =
    result.excerpt.length > 120
      ? result.excerpt.slice(0, 117) + '…'
      : result.excerpt;

  lines.push(`${index + 1}. ${result.title}`);
  lines.push(`   ${scoreStr} · ${tracksStr}`);
  lines.push(`   "${shortExcerpt}"`);
  lines.push(`   ${result.absUrl}`);

  return lines;
}

/**
 * Render a SearchResponse as a richer Signal-ready message.
 *
 * Includes excerpt preview, score emoji, full arXiv URL.
 * Used by the CLI query-search script and future rich contexts.
 *
 * @returns  { text, truncated } — text is Signal-safe (truncated if too long).
 */
export function renderSearchMessage(
  response: SearchResponse,
): { text: string; truncated: boolean } {
  const lines: string[] = [];

  lines.push(`🔍 Search: "${response.query}"`);

  if (response.count === 0) {
    lines.push('');
    lines.push('No papers found in your library for this query.');
    lines.push('');
    lines.push('Try: /search <shorter term> or /weekly for recent papers');
    return truncateForSignal(lines.join('\n'));
  }

  lines.push(`${response.count} result${response.count === 1 ? '' : 's'} from your library:`);
  lines.push('');

  for (let i = 0; i < response.results.length; i++) {
    lines.push(...formatResultRich(response.results[i]!, i));
    if (i < response.results.length - 1) {
      lines.push('');
    }
  }

  lines.push('');
  lines.push("→ /weekly for this week's papers · /reading-list for saved");

  return truncateForSignal(lines.join('\n'));
}

/**
 * Compact one-line summary for testing / logging.
 */
export function renderSearchCompact(response: SearchResponse): string {
  if (response.count === 0) {
    return `search "${response.query}": no results`;
  }
  const topScore = response.results[0]?.llmScore;
  const scoreStr =
    topScore !== null && topScore !== undefined ? `, top score ${topScore}/5` : '';
  return `search "${response.query}": ${response.count} result${response.count === 1 ? '' : 's'}${scoreStr}`;
}
