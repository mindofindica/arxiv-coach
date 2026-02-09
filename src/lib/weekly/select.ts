import fs from 'node:fs';
import type { Db } from '../db.js';

/**
 * Calculate ISO week string from a date.
 * Format: "YYYY-Www" (e.g., "2026-W06")
 */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Get the date range (Mon 00:00:00 to Sun 23:59:59.999) for an ISO week.
 */
export function weekDateRange(weekIso: string): { start: Date; end: Date } {
  // Parse "YYYY-Www"
  const match = weekIso.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`Invalid ISO week format: ${weekIso}`);
  
  const year = parseInt(match[1]!, 10);
  const week = parseInt(match[2]!, 10);
  
  // Find January 4 of the year (always in week 1 of ISO calendar)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  
  // Monday of week 1
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  
  // Monday of the target week
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  
  // Sunday of the target week
  const targetSunday = new Date(targetMonday);
  targetSunday.setUTCDate(targetMonday.getUTCDate() + 6);
  targetSunday.setUTCHours(23, 59, 59, 999);
  
  return { start: targetMonday, end: targetSunday };
}

export interface WeeklyCandidate {
  rank: number;
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  score: number;
  tracks: string[];
  absUrl: string | null;
  pdfUrl: string | null;
}

interface TrackMatchRow {
  arxivId: string;
  trackName: string;
  score: number;
  title: string;
  abstract: string;
  authorsJson: string;
  metaPath: string;
  matchedAt: string;
}

/**
 * Select the top candidates for the weekly deep dive shortlist.
 * Queries all papers matched in the given ISO week, ranks by highest score,
 * and returns up to `maxCandidates` unique papers.
 */
export function selectWeeklyShortlist(
  db: Db,
  weekIso: string,
  opts: { maxCandidates?: number } = {}
): WeeklyCandidate[] {
  const { maxCandidates = 3 } = opts;
  const { start, end } = weekDateRange(weekIso);
  
  // Query all track matches from this week
  const rows = db.sqlite.prepare(
    `SELECT
      tm.arxiv_id as arxivId,
      tm.track_name as trackName,
      tm.score as score,
      tm.matched_at as matchedAt,
      p.title as title,
      p.abstract as abstract,
      p.authors_json as authorsJson,
      p.meta_path as metaPath
     FROM track_matches tm
     JOIN papers p ON p.arxiv_id = tm.arxiv_id
     WHERE tm.matched_at >= ? AND tm.matched_at <= ?
     ORDER BY tm.score DESC, tm.matched_at DESC
    `
  ).all(start.toISOString(), end.toISOString()) as TrackMatchRow[];

  // Aggregate by paper: find max score and collect all tracks
  const paperMap = new Map<string, {
    arxivId: string;
    title: string;
    authors: string[];
    abstract: string;
    maxScore: number;
    tracks: Set<string>;
    metaPath: string;
  }>();

  for (const r of rows) {
    if (!paperMap.has(r.arxivId)) {
      let authors: string[] = [];
      try {
        authors = JSON.parse(r.authorsJson);
      } catch { /* ignore */ }

      paperMap.set(r.arxivId, {
        arxivId: r.arxivId,
        title: r.title,
        authors,
        abstract: r.abstract,
        maxScore: r.score,
        tracks: new Set([r.trackName]),
        metaPath: r.metaPath,
      });
    } else {
      const entry = paperMap.get(r.arxivId)!;
      entry.tracks.add(r.trackName);
      if (r.score > entry.maxScore) {
        entry.maxScore = r.score;
      }
    }
  }

  // Sort by maxScore DESC, then by number of tracks DESC (more tracks = more relevant)
  const sorted = Array.from(paperMap.values()).sort((a, b) => {
    if (b.maxScore !== a.maxScore) return b.maxScore - a.maxScore;
    return b.tracks.size - a.tracks.size;
  });

  // Take top N
  const candidates: WeeklyCandidate[] = [];
  const count = Math.min(maxCandidates, sorted.length);
  for (let i = 0; i < count; i++) {
    const p = sorted[i]!;
    let absUrl: string | null = null;
    let pdfUrl: string | null = null;
    
    try {
      const meta = JSON.parse(fs.readFileSync(p.metaPath, 'utf8')) as { absUrl?: string; pdfUrl?: string };
      absUrl = meta.absUrl ?? null;
      pdfUrl = meta.pdfUrl ?? null;
    } catch { /* ignore */ }

    candidates.push({
      rank: i + 1,
      arxivId: p.arxivId,
      title: p.title,
      authors: p.authors,
      abstract: p.abstract,
      score: p.maxScore,
      tracks: Array.from(p.tracks),
      absUrl,
      pdfUrl,
    });
  }

  return candidates;
}

/**
 * Select a single paper for the weekly deep dive.
 * Checks for a user pick file first, falls back to highest-scored paper.
 * 
 * @param pickFilePath - Path to check for user's pick (JSON with { arxivId: string })
 */
export function selectWeeklyPaper(
  db: Db,
  weekIso: string,
  pickFilePath: string | null
): WeeklyCandidate | null {
  const candidates = selectWeeklyShortlist(db, weekIso, { maxCandidates: 10 });
  
  if (candidates.length === 0) {
    return null;
  }

  // Check for user pick
  if (pickFilePath) {
    try {
      if (fs.existsSync(pickFilePath)) {
        const pick = JSON.parse(fs.readFileSync(pickFilePath, 'utf8')) as { arxivId?: string };
        if (pick.arxivId) {
          const found = candidates.find(c => c.arxivId === pick.arxivId);
          if (found) {
            return { ...found, rank: 1 };
          }
          // User's pick not found in this week's candidates - ignore and auto-select
        }
      }
    } catch {
      // Invalid pick file - ignore and auto-select
    }
  }

  // Auto-select: highest scored paper (first candidate)
  return candidates[0] ?? null;
}

/**
 * Get related papers for the weekly deep dive context.
 * Returns all other papers from the same week (excluding the selected paper).
 */
export function getRelatedPapers(
  db: Db,
  weekIso: string,
  excludeArxivId: string,
  opts: { maxRelated?: number } = {}
): Array<{ arxivId: string; title: string; score: number; tracks: string[] }> {
  const { maxRelated = 10 } = opts;
  const candidates = selectWeeklyShortlist(db, weekIso, { maxCandidates: maxRelated + 1 });
  
  return candidates
    .filter(c => c.arxivId !== excludeArxivId)
    .slice(0, maxRelated)
    .map(c => ({
      arxivId: c.arxivId,
      title: c.title,
      score: c.score,
      tracks: c.tracks,
    }));
}
