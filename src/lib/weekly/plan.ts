import type { Db } from '../db.js';

export interface WeeklyPaperInfo {
  arxivId: string;
  title: string;
  authors: string[];
  abstract: string;
  absUrl: string | null;
  pdfUrl: string | null;
  score: number;
  tracks: string[];
  textPath: string;
  hasFullText: boolean;
}

export interface RelatedPaperInfo {
  arxivId: string;
  title: string;
  score: number;
  tracks: string[];
}

export interface WeeklyPlan {
  kind: 'weeklyPlan';
  weekIso: string;
  alreadySent: boolean;
  selectedPaper: WeeklyPaperInfo | null;
  relatedPapers: RelatedPaperInfo[];
  sections: string[];
  headerMessage: string;
}

export interface WeeklyShortlistPlan {
  kind: 'weeklyShortlist';
  weekIso: string;
  alreadySent: boolean;
  candidates: Array<{
    rank: number;
    arxivId: string;
    title: string;
    score: number;
    tracks: string[];
    absUrl: string | null;
    abstract: string;
  }>;
  shortlistMessage: string;
}

export const WEEKLY_SECTIONS = [
  'header',
  'tldr',
  'key_ideas',
  'how_it_works',
  'why_it_matters',
  'related',
] as const;

/**
 * Check if a weekly deep dive has already been sent for the given ISO week.
 */
export function hasWeeklyBeenSent(db: Db, weekIso: string): boolean {
  const row = db.sqlite.prepare('SELECT week_iso FROM sent_weekly_digests WHERE week_iso=?').get(weekIso) as any;
  return Boolean(row);
}

/**
 * Mark a weekly deep dive as sent.
 */
export function markWeeklySent(
  db: Db,
  weekIso: string,
  arxivId: string,
  sectionsJson: string
): void {
  db.sqlite.prepare(
    `INSERT OR REPLACE INTO sent_weekly_digests (week_iso, kind, sent_at, arxiv_id, sections_json)
     VALUES (?, 'weekly', ?, ?, ?)`
  ).run(weekIso, new Date().toISOString(), arxivId, sectionsJson);
}

/**
 * Get the record of a sent weekly digest.
 */
export function getWeeklySentRecord(
  db: Db,
  weekIso: string
): { weekIso: string; arxivId: string; sentAt: string; sectionsJson: string } | null {
  const row = db.sqlite.prepare(
    'SELECT week_iso, arxiv_id, sent_at, sections_json FROM sent_weekly_digests WHERE week_iso=?'
  ).get(weekIso) as any;
  
  if (!row) return null;
  
  return {
    weekIso: row.week_iso,
    arxivId: row.arxiv_id,
    sentAt: row.sent_at,
    sectionsJson: row.sections_json,
  };
}
