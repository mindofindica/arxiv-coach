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
  llmScore: number | null;
}

export interface DailySelection {
  byTrack: Map<string, SelectedPaper[]>;
  totals: {
    tracksWithItems: number;
    items: number;
  };
}

export function selectDailyByTrack(db: Db, opts: { maxItemsPerDigest: number; maxPerTrack: number; dedupDays?: number }): DailySelection {
  // Exclude papers already sent within dedupDays (default: 7 days)
  const dedupDays = opts.dedupDays ?? 7;
  const rows = db.sqlite.prepare(
    `SELECT
      tm.track_name as trackName,
      tm.score as score,
      tm.matched_terms_json as matchedTermsJson,
      p.arxiv_id as arxivId,
      p.title as title,
      p.abstract as abstract,
      p.updated_at as updatedAt,
      p.meta_path as metaPath,
      ls.relevance_score as llmScore
     FROM track_matches tm
     JOIN papers p ON p.arxiv_id = tm.arxiv_id
     LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
     WHERE NOT EXISTS (
       SELECT 1 FROM digest_papers dp
       WHERE dp.arxiv_id = p.arxiv_id
         AND dp.digest_date >= date('now', ? || ' days')
     )
     ORDER BY
       CASE WHEN ls.relevance_score IS NOT NULL THEN 0 ELSE 1 END,
       COALESCE(ls.relevance_score, 0) DESC,
       tm.score DESC,
       tm.matched_at DESC
    `
  ).all(`-${dedupDays}`) as Array<any>;

  const byTrack = new Map<string, SelectedPaper[]>();

  for (const r of rows) {
    // Filter out papers with low LLM scores (noise filter)
    if (r.llmScore !== null && r.llmScore <= 2) continue;

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
      llmScore: r.llmScore ?? null,
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
