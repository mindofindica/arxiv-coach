/**
 * FTS5 paper search for arxiv-coach.
 *
 * Exposes `searchPapers` which runs a porter-stemmed full-text query over
 * the `papers_fts` virtual table (title + abstract).  Results are returned
 * newest-first within each FTS rank bucket, optionally filtered by a date
 * window.
 *
 * `formatSearchReply` renders results as a Signal-friendly plain-text message
 * (no markdown tables; short titles; arxiv link on its own line for tap-ability).
 */

import type { Db } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** FTS5 query string (Porter-stemmed by default; supports phrase queries with "...") */
  query: string;
  /** Maximum results to return (1–20, default 5) */
  limit?: number;
  /**
   * ISO date prefix to filter published_at, e.g. "2026" or "2025-10".
   * Papers published before this prefix are excluded.
   */
  from?: string | null;
  /**
   * Track name filter: if set, only papers that matched this track
   * (have a row in track_matches) are returned.
   */
  track?: string | null;
}

export interface SearchResult {
  arxivId: string;
  title: string;
  publishedAt: string;   // ISO 8601
  abstract: string;      // may be long — callers truncate as needed
  tracks: string[];      // track names this paper matched (may be empty)
  llmScore: number | null; // 1–5 LLM relevance score, if scored
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;   // how many FTS hits (before limit/track filter)
  query: string;        // echo of the query
}

// ── Row types (SQLite result shapes) ──────────────────────────────────────

interface FtsRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  published_at: string;
}

interface TrackRow {
  arxiv_id: string;
  track_name: string;
}

interface ScoreRow {
  arxiv_id: string;
  relevance_score: number;
}

interface CountRow {
  n: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitise a user query string for safe FTS5 use.
 *
 * Strategy:
 *   - If the query is already wrapped in double-quotes, treat as a phrase
 *     search (most specific) and pass it through.
 *   - Otherwise, strip any stray double-quotes (which would cause FTS5
 *     parse errors if unbalanced) and return the bare keywords.
 *     FTS5 treats space-separated bare keywords as implicit AND — matching
 *     documents that contain all the words, in any order.  This is the most
 *     natural Signal-input behaviour:
 *
 *     /search speculative decoding     → speculative decoding   (AND)
 *     /search "LoRA fine-tuning"       → "LoRA fine-tuning"     (phrase)
 *     /search RAG retrieval augmented  → RAG retrieval augmented (AND)
 */
export function sanitiseQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // If already properly double-quoted, pass through as phrase search
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    return trimmed;
  }
  // Strip any stray double-quotes (would cause FTS5 parse errors if unbalanced)
  // Also replace hyphens with spaces: in FTS5 query syntax, a leading `-` means
  // NOT (e.g. `high-quality` parses as `high AND NOT quality`).
  // Converting to spaces makes `high-quality` → `high quality` (AND semantics).
  return trimmed.replace(/"/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Core search function ───────────────────────────────────────────────────

/**
 * Run a full-text search over the papers corpus.
 *
 * Returns up to `limit` results ranked by FTS score (most relevant first),
 * then by published_at DESC (newest wins on ties).
 */
export function searchPapers(db: Db, opts: SearchOptions): SearchResponse {
  const { query, limit = 5, from = null, track = null } = opts;

  const safeQuery = sanitiseQuery(query);
  if (!safeQuery) {
    return { results: [], totalCount: 0, query };
  }
  const clampedLimit = Math.max(1, Math.min(20, limit));

  // ── Count total FTS hits (unfiltered by track / from) ─────────────────
  let totalCount = 0;
  try {
    const countSql = from
      ? `SELECT COUNT(*) as n
         FROM papers_fts f
         JOIN papers p ON p.arxiv_id = f.arxiv_id
         WHERE papers_fts MATCH ?
           AND p.published_at >= ?`
      : `SELECT COUNT(*) as n
         FROM papers_fts
         WHERE papers_fts MATCH ?`;

    const countRow = (
      from
        ? db.sqlite.prepare(countSql).get(safeQuery, from)
        : db.sqlite.prepare(countSql).get(safeQuery)
    ) as CountRow | undefined;

    totalCount = countRow?.n ?? 0;
  } catch {
    // FTS syntax error — return zero results gracefully
    return { results: [], totalCount: 0, query };
  }

  if (totalCount === 0) {
    return { results: [], totalCount: 0, query };
  }

  // ── Fetch FTS results ──────────────────────────────────────────────────
  // We fetch more than needed to allow for track filtering, then trim.
  const fetchLimit = track ? clampedLimit * 5 : clampedLimit;

  let ftsRows: FtsRow[];
  try {
    const fetchSql = from
      ? `SELECT f.arxiv_id, p.title, p.abstract, p.published_at
         FROM papers_fts f
         JOIN papers p ON p.arxiv_id = f.arxiv_id
         WHERE papers_fts MATCH ?
           AND p.published_at >= ?
         ORDER BY rank, p.published_at DESC
         LIMIT ?`
      : `SELECT f.arxiv_id, p.title, p.abstract, p.published_at
         FROM papers_fts f
         JOIN papers p ON p.arxiv_id = f.arxiv_id
         WHERE papers_fts MATCH ?
         ORDER BY rank, p.published_at DESC
         LIMIT ?`;

    ftsRows = (
      from
        ? db.sqlite.prepare(fetchSql).all(safeQuery, from, fetchLimit)
        : db.sqlite.prepare(fetchSql).all(safeQuery, fetchLimit)
    ) as FtsRow[];
  } catch {
    return { results: [], totalCount: 0, query };
  }

  if (ftsRows.length === 0) {
    return { results: [], totalCount, query };
  }

  // ── Fetch track matches for these papers ───────────────────────────────
  const arxivIds = ftsRows.map((r) => r.arxiv_id);
  const placeholders = arxivIds.map(() => '?').join(', ');

  let trackMap: Map<string, string[]> = new Map();
  try {
    const trackRows = db.sqlite
      .prepare(
        `SELECT arxiv_id, track_name FROM track_matches WHERE arxiv_id IN (${placeholders})`,
      )
      .all(...arxivIds) as TrackRow[];

    for (const row of trackRows) {
      const existing = trackMap.get(row.arxiv_id) ?? [];
      existing.push(row.track_name);
      trackMap.set(row.arxiv_id, existing);
    }
  } catch {
    // track_matches may not exist in very old DBs — ignore
  }

  // ── Fetch LLM scores ───────────────────────────────────────────────────
  let scoreMap: Map<string, number> = new Map();
  try {
    const scoreRows = db.sqlite
      .prepare(
        `SELECT arxiv_id, relevance_score FROM llm_scores WHERE arxiv_id IN (${placeholders})`,
      )
      .all(...arxivIds) as ScoreRow[];

    for (const row of scoreRows) {
      scoreMap.set(row.arxiv_id, row.relevance_score);
    }
  } catch {
    // llm_scores may not exist — ignore
  }

  // ── Assemble results with optional track filter ────────────────────────
  const results: SearchResult[] = [];
  const trackLower = track?.toLowerCase() ?? null;

  for (const row of ftsRows) {
    if (results.length >= clampedLimit) break;

    const tracks = trackMap.get(row.arxiv_id) ?? [];

    if (trackLower) {
      const hasTrack = tracks.some((t) => t.toLowerCase().includes(trackLower));
      if (!hasTrack) continue;
    }

    results.push({
      arxivId: row.arxiv_id,
      title: row.title,
      publishedAt: row.published_at,
      abstract: row.abstract,
      tracks,
      llmScore: scoreMap.get(row.arxiv_id) ?? null,
    });
  }

  return { results, totalCount, query };
}

// ── Signal formatter ───────────────────────────────────────────────────────

/**
 * Format a search response as a plain-text Signal message.
 *
 * Design constraints:
 *   - No markdown tables (Signal strips them)
 *   - Titles truncated to 65 chars (readable on mobile)
 *   - arxiv ID on its own line (tap-to-copy friendly)
 *   - Track badges in parentheses if present
 *   - LLM score (1–5 ★) when available
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

    // Title: truncate at 65 chars
    const title = r.title.length > 65 ? r.title.slice(0, 62) + '…' : r.title;

    // Date: just YYYY-MM-DD
    const date = r.publishedAt.slice(0, 10);

    // Track badge (first two tracks to keep it short)
    const trackBadge =
      r.tracks.length > 0 ? ` [${r.tracks.slice(0, 2).join(', ')}]` : '';

    // LLM score
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
