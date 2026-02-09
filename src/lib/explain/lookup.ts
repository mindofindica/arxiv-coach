import fs from 'node:fs';
import type { Db } from '../db.js';
import type { LookupResult, PaperInfo } from './types.js';

// Stopwords to filter out from fuzzy title search
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'about', 'paper', 'one',
]);

// Pattern for arxiv IDs (e.g., "2602.06038" or "2602.06038v1")
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}(v\d+)?$/;

// Pattern for digest reference (e.g., "#2 from today", "paper #1 from 2026-02-08")
const DIGEST_REF_PATTERN = /#(\d+)\s*(?:from\s+)?(today|yesterday|\d{4}-\d{2}-\d{2})?/i;

/**
 * Detect the type of query and route to appropriate lookup strategy
 */
function detectQueryType(query: string): 'arxiv-id' | 'title-search' | 'digest-ref' {
  const trimmed = query.trim();
  
  if (ARXIV_ID_PATTERN.test(trimmed)) {
    return 'arxiv-id';
  }
  
  if (DIGEST_REF_PATTERN.test(trimmed)) {
    return 'digest-ref';
  }
  
  return 'title-search';
}

/**
 * Strip version suffix from arxiv ID (e.g., "2602.06038v1" → "2602.06038")
 */
function stripVersion(arxivId: string): string {
  return arxivId.replace(/v\d+$/, '');
}

/**
 * Parse date reference from digest query
 */
function parseDigestDate(dateRef: string | undefined, now: Date = new Date()): string {
  if (!dateRef || dateRef.toLowerCase() === 'today') {
    return formatDate(now);
  }
  
  if (dateRef.toLowerCase() === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return formatDate(yesterday);
  }
  
  // Already in YYYY-MM-DD format
  return dateRef;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Extract meaningful tokens from a search query
 */
function extractTokens(query: string): string[] {
  return query
    .toLowerCase()
    // Replace hyphens/underscores with spaces to split compound words
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Build PaperInfo from database row
 */
function rowToPaperInfo(row: PaperRow, tracks: string[], score: number): PaperInfo {
  const authors = JSON.parse(row.authors_json) as string[];
  
  // Try to read absUrl from meta.json
  let absUrl: string | null = null;
  let pdfUrl: string | null = null;
  
  if (row.meta_path && fs.existsSync(row.meta_path)) {
    try {
      const meta = JSON.parse(fs.readFileSync(row.meta_path, 'utf8'));
      absUrl = meta.absUrl ?? null;
      pdfUrl = meta.pdfUrl ?? null;
    } catch {
      // Ignore parse errors
    }
  }
  
  return {
    arxivId: row.arxiv_id,
    title: row.title,
    authors,
    abstract: row.abstract,
    score,
    tracks,
    pdfPath: row.pdf_path,
    txtPath: row.txt_path,
    metaPath: row.meta_path,
    absUrl,
    pdfUrl,
  };
}

interface PaperRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  authors_json: string;
  categories_json: string;
  pdf_path: string;
  txt_path: string;
  meta_path: string;
}

interface TrackMatchRow {
  arxiv_id: string;
  track_name: string;
  score: number;
}

/**
 * Lookup paper by exact arxiv ID
 */
function lookupByArxivId(db: Db, arxivId: string): LookupResult {
  const cleanId = stripVersion(arxivId);
  
  const row = db.sqlite.prepare(`
    SELECT arxiv_id, title, abstract, authors_json, categories_json,
           pdf_path, txt_path, meta_path
    FROM papers
    WHERE arxiv_id = ?
  `).get(cleanId) as PaperRow | undefined;
  
  if (!row) {
    return { status: 'not-found', query: arxivId, method: 'arxiv-id' };
  }
  
  // Get track matches for this paper
  const matches = db.sqlite.prepare(`
    SELECT track_name, score FROM track_matches
    WHERE arxiv_id = ?
  `).all(cleanId) as TrackMatchRow[];
  
  const tracks = matches.map(m => m.track_name);
  const score = Math.max(0, ...matches.map(m => m.score));
  
  return {
    status: 'found',
    paper: rowToPaperInfo(row, tracks, score),
    query: arxivId,
    method: 'arxiv-id',
  };
}

/**
 * Lookup paper by fuzzy title search
 */
function lookupByTitle(db: Db, query: string): LookupResult {
  const tokens = extractTokens(query);
  
  if (tokens.length === 0) {
    return { status: 'not-found', query, method: 'title-search' };
  }
  
  // Build SQL with LIKE conditions for each token
  const conditions = tokens.map(() => `LOWER(p.title) LIKE ?`).join(' AND ');
  const params = tokens.map(t => `%${t}%`);
  
  const sql = `
    SELECT p.arxiv_id, p.title, p.abstract, p.authors_json, p.categories_json,
           p.pdf_path, p.txt_path, p.meta_path,
           COALESCE(MAX(tm.score), 0) as max_score,
           GROUP_CONCAT(tm.track_name, '|') as track_names
    FROM papers p
    LEFT JOIN track_matches tm ON p.arxiv_id = tm.arxiv_id
    WHERE ${conditions}
    GROUP BY p.arxiv_id
    ORDER BY max_score DESC
    LIMIT 10
  `;
  
  const rows = db.sqlite.prepare(sql).all(...params) as Array<PaperRow & { max_score: number; track_names: string | null }>;
  
  if (rows.length === 0) {
    return { status: 'not-found', query, method: 'title-search' };
  }
  
  if (rows.length === 1) {
    const row = rows[0]!;
    const tracks = row.track_names?.split('|').filter(Boolean) ?? [];
    return {
      status: 'found',
      paper: rowToPaperInfo(row, tracks, row.max_score),
      query,
      method: 'title-search',
    };
  }
  
  // Multiple matches - return as ambiguous
  const candidates = rows.map(row => {
    const tracks = row.track_names?.split('|').filter(Boolean) ?? [];
    return rowToPaperInfo(row, tracks, row.max_score);
  });
  
  return {
    status: 'ambiguous',
    candidates,
    query,
    method: 'title-search',
  };
}

/**
 * Lookup paper by digest reference (e.g., "#2 from today")
 */
function lookupByDigestRef(db: Db, query: string, now: Date = new Date()): LookupResult {
  const match = DIGEST_REF_PATTERN.exec(query);
  
  if (!match) {
    return { status: 'not-found', query, method: 'digest-ref' };
  }
  
  const position = parseInt(match[1]!, 10);
  const dateRef = match[2];
  const targetDate = parseDigestDate(dateRef, now);
  
  // Query papers matched on that date, ordered by score
  // The date in matched_at is an ISO timestamp, so we need to match the date prefix
  const rows = db.sqlite.prepare(`
    SELECT p.arxiv_id, p.title, p.abstract, p.authors_json, p.categories_json,
           p.pdf_path, p.txt_path, p.meta_path,
           MAX(tm.score) as max_score,
           GROUP_CONCAT(tm.track_name, '|') as track_names
    FROM papers p
    JOIN track_matches tm ON p.arxiv_id = tm.arxiv_id
    WHERE tm.matched_at LIKE ? || '%'
    GROUP BY p.arxiv_id
    ORDER BY max_score DESC
  `).all(targetDate) as Array<PaperRow & { max_score: number; track_names: string | null }>;
  
  if (rows.length === 0) {
    return { status: 'not-found', query, method: 'digest-ref' };
  }
  
  // Position is 1-indexed
  if (position < 1 || position > rows.length) {
    return { status: 'not-found', query, method: 'digest-ref' };
  }
  
  const row = rows[position - 1]!;
  const tracks = row.track_names?.split('|').filter(Boolean) ?? [];
  
  return {
    status: 'found',
    paper: rowToPaperInfo(row, tracks, row.max_score),
    query,
    method: 'digest-ref',
  };
}

/**
 * Main lookup function - auto-detects query type and routes to appropriate strategy
 */
export function lookupPaper(db: Db, query: string, now?: Date): LookupResult {
  const queryType = detectQueryType(query);
  
  switch (queryType) {
    case 'arxiv-id':
      return lookupByArxivId(db, query.trim());
    case 'digest-ref':
      return lookupByDigestRef(db, query, now);
    case 'title-search':
      return lookupByTitle(db, query);
  }
}

// Export helpers for testing
export { detectQueryType, extractTokens, stripVersion, parseDigestDate };
