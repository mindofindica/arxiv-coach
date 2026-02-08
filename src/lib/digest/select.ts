import type { Db } from '../db.js';

export interface SelectedPaper {
  arxivId: string;
  title: string;
  abstract: string;
  updatedAt: string;
  absUrl: string | null;
  pdfUrl: string | null;
  score: number;
  matchedTerms: string[];
  trackName: string;
}

export interface DailySelection {
  byTrack: Map<string, SelectedPaper[]>;
  totals: {
    tracksWithItems: number;
    items: number;
  };
}

export function selectDailyByTrack(db: Db, opts: { maxItemsPerDigest: number; maxPerTrack: number }): DailySelection {
  const rows = db.sqlite.prepare(
    `SELECT
      tm.track_name as trackName,
      tm.score as score,
      tm.matched_terms_json as matchedTermsJson,
      p.arxiv_id as arxivId,
      p.title as title,
      p.abstract as abstract,
      p.updated_at as updatedAt,
      p.meta_path as metaPath
     FROM track_matches tm
     JOIN papers p ON p.arxiv_id = tm.arxiv_id
     ORDER BY tm.score DESC, tm.matched_at DESC
    `
  ).all() as Array<any>;

  const byTrack = new Map<string, SelectedPaper[]>();

  for (const r of rows) {
    if (!byTrack.has(r.trackName)) byTrack.set(r.trackName, []);
    const list = byTrack.get(r.trackName)!;
    if (list.length >= opts.maxPerTrack) continue;

    let pdfUrl: string | null = null;
    let absUrl: string | null = null;
    try {
      const meta = JSON.parse(require('node:fs').readFileSync(r.metaPath, 'utf8')) as { pdfUrl?: string; absUrl?: string };
      pdfUrl = meta.pdfUrl ?? null;
      absUrl = meta.absUrl ?? null;
    } catch {
      // ignore
    }

    list.push({
      arxivId: r.arxivId,
      title: r.title,
      abstract: r.abstract,
      updatedAt: r.updatedAt,
      absUrl,
      pdfUrl,
      score: r.score,
      matchedTerms: safeJsonArray(r.matchedTermsJson),
      trackName: r.trackName,
    });
  }

  // Cap total across tracks (preserving track grouping order in DB sort)
  let total = 0;
  for (const [t, list] of byTrack) {
    if (total >= opts.maxItemsPerDigest) {
      byTrack.set(t, []);
      continue;
    }
    const room = opts.maxItemsPerDigest - total;
    if (list.length > room) {
      byTrack.set(t, list.slice(0, room));
      total += room;
    } else {
      total += list.length;
    }
  }

  // Remove empty tracks
  for (const [t, list] of Array.from(byTrack.entries())) {
    if (list.length === 0) byTrack.delete(t);
  }

  return {
    byTrack,
    totals: {
      tracksWithItems: byTrack.size,
      items: Array.from(byTrack.values()).reduce((s, l) => s + l.length, 0),
    },
  };
}

function safeJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
