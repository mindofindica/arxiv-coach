/**
 * Personalised paper recommendations for arxiv-coach.
 *
 * Strategy:
 *   1. Collect "seed papers" from high-signal positive feedback:
 *      - paper_feedback WHERE feedback_type IN ('love', 'save')
 *      - reading_list WHERE priority >= 7
 *   2. Extract keywords from seed paper titles + abstracts (stop-word filtered)
 *   3. Run FTS5 queries to find corpus papers similar to those keywords
 *   4. Exclude papers already seen (digest_papers, reading_list, paper_feedback)
 *   5. Re-rank by FTS relevance + llm_score + recency; return top-N
 *
 * Usage:
 *   const result = recommendPapers(db, { limit: 5, track: 'LLM' });
 */

import type { Db } from '../db.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RecommendOptions {
  /** Max papers to return (1–20, default 5) */
  limit?: number;
  /**
   * Track name filter — only recommend papers from this track.
   * Case-insensitive substring match.
   */
  track?: string | null;
  /**
   * Minimum number of seed papers required to build a recommendation profile.
   * If fewer seeds are found, returns an empty result with a hint.
   */
  minSeeds?: number;
}

export interface RecommendResult {
  arxivId: string;
  title: string;
  publishedAt: string;
  abstract: string;
  tracks: string[];
  llmScore: number | null;
  /** How many seed keyword clusters matched this paper */
  matchStrength: number;
}

export interface RecommendResponse {
  results: RecommendResult[];
  seedCount: number;     // how many seed papers were used to build the profile
  keywords: string[];    // top keywords extracted from seeds (for transparency)
  /** Reason when no results could be produced */
  reason?: 'no_seeds' | 'no_results';
}

// ── DB row shapes ──────────────────────────────────────────────────────────

interface SeedRow {
  paper_id: string;
  feedback_type?: string;
}

interface PaperTextRow {
  arxiv_id: string;
  title: string;
  abstract: string;
}

interface TrackRow {
  arxiv_id: string;
  track_name: string;
}

interface ScoreRow {
  arxiv_id: string;
  relevance_score: number;
}

interface FtsRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  published_at: string;
}

// ── Stop words — common English words that don't carry semantic meaning ────
// Kept minimal: FTS5 porter stemmer handles most noise, but these words
// produce too many noisy matches when used as query terms.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that',
  'these', 'those', 'we', 'our', 'they', 'their', 'it', 'its', 'via',
  'using', 'show', 'study', 'approach', 'method', 'model', 'paper',
  'work', 'based', 'also', 'across', 'over', 'under', 'into', 'each',
  'both', 'than', 'then', 'which', 'such', 'use', 'new', 'results',
  'show', 'large', 'while', 'without', 'high', 'low', 'more', 'most',
  // Technical filler words common in ML/AI paper titles
  'towards', 'toward', 'when', 'how', 'what', 'where', 'why', 'up',
  'learning', 'neural', 'networks', 'network', 'deep', 'models',
]);

/**
 * Extract top keywords from a collection of paper titles and abstracts.
 *
 * Returns at most `topN` unique tokens, sorted by frequency (desc).
 * Tokens must be >= 4 chars, alpha-only (no numbers), and not in STOP_WORDS.
 *
 * We use only the title (not abstract) for keyword extraction — titles are
 * dense signal; abstracts would dilute with too many generic ML terms.
 */
export function extractKeywords(titles: string[], topN = 12): string[] {
  const freq = new Map<string, number>();

  for (const title of titles) {
    // Tokenise: split on non-alpha chars, lowercase
    const tokens = title
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(t => t.length >= 4 && !STOP_WORDS.has(t));

    for (const tok of tokens) {
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }

  // Sort by frequency desc, then alpha for determinism
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([tok]) => tok);
}

/**
 * Build an FTS5 query string from keywords.
 *
 * Groups keywords into chunks of `chunkSize` terms connected by OR.
 * Using OR (not AND) maximises recall — we want any paper that touches
 * themes from the user's taste profile.
 *
 * Returns the raw FTS5 query string, or null if no keywords.
 */
export function buildFtsQuery(keywords: string[]): string | null {
  if (keywords.length === 0) return null;
  // FTS5 OR is written as space-separated terms in a single MATCH clause.
  // Wrapping each keyword in double-quotes prevents porter stemmer mismatch
  // issues on short terms (e.g. "rlhf" vs rlhf after stemming).
  // We don't quote here — FTS5 porter will stem them consistently with
  // how they're stored in the index.
  return keywords.join(' OR ');
}

// ── Core recommendation engine ────────────────────────────────────────────

/**
 * Recommend papers based on the user's positive feedback history.
 *
 * Returns papers similar to loved/saved papers that haven't been seen yet.
 */
export function recommendPapers(db: Db, opts: RecommendOptions = {}): RecommendResponse {
  const { limit = 5, track = null, minSeeds = 1 } = opts;
  const clampedLimit = Math.max(1, Math.min(20, limit));

  // ── Step 1: Collect seed papers (loved + saved feedback + high-priority reading list) ─

  let seedIds: Set<string> = new Set();

  // From paper_feedback: love and save signals
  try {
    const feedbackSeeds = db.sqlite
      .prepare(
        `SELECT paper_id FROM paper_feedback
         WHERE feedback_type IN ('love', 'save')
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all() as SeedRow[];
    for (const r of feedbackSeeds) seedIds.add(r.paper_id);
  } catch {
    // Table may not exist on fresh installs
  }

  // From reading_list: priority >= 7 (high-value saves)
  try {
    const readingSeeds = db.sqlite
      .prepare(
        `SELECT paper_id FROM reading_list
         WHERE priority >= 7
         ORDER BY priority DESC, created_at DESC
         LIMIT 30`,
      )
      .all() as SeedRow[];
    for (const r of readingSeeds) seedIds.add(r.paper_id);
  } catch {
    // Ignore
  }

  if (seedIds.size < minSeeds) {
    return {
      results: [],
      seedCount: seedIds.size,
      keywords: [],
      reason: 'no_seeds',
    };
  }

  // ── Step 2: Fetch titles of seed papers ───────────────────────────────

  const seedIdList = [...seedIds];
  const placeholders = seedIdList.map(() => '?').join(', ');

  let seedPapers: PaperTextRow[] = [];
  try {
    seedPapers = db.sqlite
      .prepare(
        `SELECT arxiv_id, title, abstract FROM papers
         WHERE arxiv_id IN (${placeholders})`,
      )
      .all(...seedIdList) as PaperTextRow[];
  } catch {
    return { results: [], seedCount: seedIds.size, keywords: [], reason: 'no_results' };
  }

  if (seedPapers.length === 0) {
    return { results: [], seedCount: seedIds.size, keywords: [], reason: 'no_seeds' };
  }

  // ── Step 3: Extract keywords from seed titles ──────────────────────────

  const keywords = extractKeywords(seedPapers.map(p => p.title), 12);
  const ftsQuery = buildFtsQuery(keywords);

  if (!ftsQuery) {
    return { results: [], seedCount: seedIds.size, keywords: [], reason: 'no_results' };
  }

  // ── Step 4: Build exclusion set (already seen / interacted) ───────────

  const excluded: Set<string> = new Set(seedIdList); // never recommend seeds themselves

  // Papers already in the reading list (any priority)
  try {
    const rl = db.sqlite
      .prepare('SELECT paper_id FROM reading_list')
      .all() as { paper_id: string }[];
    for (const r of rl) excluded.add(r.paper_id);
  } catch { /* ignore */ }

  // Papers already given any feedback
  try {
    const fb = db.sqlite
      .prepare('SELECT paper_id FROM paper_feedback')
      .all() as { paper_id: string }[];
    for (const r of fb) excluded.add(r.paper_id);
  } catch { /* ignore */ }

  // Papers already sent in a digest (seen at least once)
  try {
    const dp = db.sqlite
      .prepare('SELECT DISTINCT arxiv_id FROM digest_papers')
      .all() as { arxiv_id: string }[];
    for (const r of dp) excluded.add(r.arxiv_id);
  } catch { /* ignore */ }

  // ── Step 5: FTS5 search with over-fetch to allow for filtering ─────────

  const fetchLimit = clampedLimit * 8; // over-fetch: we'll filter and rank

  let ftsRows: FtsRow[] = [];
  try {
    const trackFilter = track ? ` AND EXISTS (
      SELECT 1 FROM track_matches tm
      WHERE tm.arxiv_id = f.arxiv_id
        AND LOWER(tm.track_name) LIKE ?
    )` : '';

    const sql = `
      SELECT f.arxiv_id, p.title, p.abstract, p.published_at
      FROM papers_fts f
      JOIN papers p ON p.arxiv_id = f.arxiv_id
      WHERE papers_fts MATCH ?
      ${trackFilter}
      ORDER BY rank, p.published_at DESC
      LIMIT ?
    `;

    const trackArg = track ? `%${track.toLowerCase()}%` : null;
    if (trackArg) {
      ftsRows = db.sqlite.prepare(sql).all(ftsQuery, trackArg, fetchLimit) as FtsRow[];
    } else {
      ftsRows = db.sqlite.prepare(sql).all(ftsQuery, fetchLimit) as FtsRow[];
    }
  } catch (err) {
    // FTS parse error or missing table
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('fts5') || msg.includes('no such table')) {
      return { results: [], seedCount: seedIds.size, keywords, reason: 'no_results' };
    }
    throw err;
  }

  // ── Step 6: Filter out already-seen papers ─────────────────────────────

  const candidates = ftsRows.filter(r => !excluded.has(r.arxiv_id));
  if (candidates.length === 0) {
    return { results: [], seedCount: seedIds.size, keywords, reason: 'no_results' };
  }

  // ── Step 7: Enrich with tracks + LLM scores ───────────────────────────

  const candidateIds = candidates.map(r => r.arxiv_id);
  const candPlaceholders = candidateIds.map(() => '?').join(', ');

  let trackMap = new Map<string, string[]>();
  try {
    const trackRows = db.sqlite
      .prepare(
        `SELECT arxiv_id, track_name FROM track_matches WHERE arxiv_id IN (${candPlaceholders})`,
      )
      .all(...candidateIds) as TrackRow[];
    for (const r of trackRows) {
      const arr = trackMap.get(r.arxiv_id) ?? [];
      arr.push(r.track_name);
      trackMap.set(r.arxiv_id, arr);
    }
  } catch { /* ignore */ }

  let scoreMap = new Map<string, number>();
  try {
    const scoreRows = db.sqlite
      .prepare(
        `SELECT arxiv_id, relevance_score FROM llm_scores WHERE arxiv_id IN (${candPlaceholders})`,
      )
      .all(...candidateIds) as ScoreRow[];
    for (const r of scoreRows) scoreMap.set(r.arxiv_id, r.relevance_score);
  } catch { /* ignore */ }

  // ── Step 8: Score and rank candidates ─────────────────────────────────
  //
  // Combined score:
  //   - FTS rank position (lower index = stronger FTS match)
  //   - llm_score bonus (1–5 → 0–0.4 boost)
  //   - Recency bonus (within last 90 days → small boost)
  //
  // The final sort is: FTS-rank-adjusted score DESC.

  const now = Date.now();
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  interface Scored { row: FtsRow; score: number; }
  const scored: Scored[] = candidates.map((row, idx) => {
    // FTS rank position: first result = 1.0, decays as idx grows
    const ftsRankScore = 1.0 / (1 + idx * 0.15);

    // LLM score bonus: score 5 → +0.40, score 1 → +0.08
    const llm = scoreMap.get(row.arxiv_id) ?? null;
    const llmBonus = llm !== null ? (llm / 5) * 0.4 : 0;

    // Recency bonus: papers in last 90 days get up to +0.10
    const pubMs = new Date(row.published_at).getTime();
    const ageMs = now - pubMs;
    const recencyBonus = ageMs < NINETY_DAYS_MS ? 0.10 * (1 - ageMs / NINETY_DAYS_MS) : 0;

    return { row, score: ftsRankScore + llmBonus + recencyBonus };
  });

  scored.sort((a, b) => b.score - a.score);

  // ── Step 9: Assemble final results ────────────────────────────────────

  const results: RecommendResult[] = scored.slice(0, clampedLimit).map(({ row }) => ({
    arxivId: row.arxiv_id,
    title: row.title,
    publishedAt: row.published_at,
    abstract: row.abstract,
    tracks: trackMap.get(row.arxiv_id) ?? [],
    llmScore: scoreMap.get(row.arxiv_id) ?? null,
    matchStrength: 1, // all candidates passed FTS match
  }));

  return {
    results,
    seedCount: seedPapers.length,
    keywords,
  };
}

// ── Signal formatter ───────────────────────────────────────────────────────

/**
 * Format a recommend response as a plain-text Signal message.
 *
 * Design constraints:
 *   - No markdown tables (Signal strips them)
 *   - Titles truncated to 65 chars (readable on mobile)
 *   - Track badges in parentheses
 *   - Footer shows how profile was built
 */
export function formatRecommendReply(resp: RecommendResponse): string {
  if (resp.reason === 'no_seeds') {
    const needed = 1;
    return (
      `🤖 Not enough data to recommend yet.\n\n` +
      `I need at least ${needed} paper you've loved or saved. ` +
      `Send:\n` +
      `  /love <arxiv-id>  — for papers you really like\n` +
      `  /save <arxiv-id>  — for papers to read later\n\n` +
      `I'll use those signals to find papers matching your taste.`
    );
  }

  if (resp.results.length === 0) {
    return (
      `🔮 No new recommendations right now.\n\n` +
      `Everything matching your taste profile has already appeared in your digests or reading list. ` +
      `Keep giving feedback with /love and /save — I'll find more as new papers arrive.`
    );
  }

  const { results, seedCount, keywords } = resp;

  const topKw = keywords.slice(0, 5).join(', ');
  const header =
    results.length === 1
      ? `🔮 Based on ${seedCount} paper${seedCount === 1 ? '' : 's'} you loved/saved:`
      : `🔮 ${results.length} picks based on ${seedCount} paper${seedCount === 1 ? '' : 's'} you loved/saved:`;

  const lines: string[] = [header, `   Profile: ${topKw}`, ''];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const num = i + 1;

    const title = r.title.length > 65 ? r.title.slice(0, 62) + '…' : r.title;
    const date = r.publishedAt.slice(0, 10);
    const trackBadge = r.tracks.length > 0 ? ` [${r.tracks.slice(0, 2).join(', ')}]` : '';
    const scoreBadge = r.llmScore !== null ? ` ★${r.llmScore}` : '';

    lines.push(`${num}. ${title}${trackBadge}${scoreBadge}`);
    lines.push(`   ${date} · arxiv:${r.arxivId}`);
  }

  lines.push('');
  lines.push('Commands: /love <id> · /save <id> · /skip <id>');
  lines.push('Options: /recommend --limit 10 · /recommend --track LLM');

  return lines.join('\n');
}
