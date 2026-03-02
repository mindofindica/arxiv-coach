/**
 * Digest Preview — core logic
 *
 * Runs the same paper-scoring/selection pipeline used for the daily digest,
 * but does NOT mark anything as sent. Use this to see what tomorrow's digest
 * will look like before it fires.
 *
 * Key differences from the real daily pipeline:
 *   - No DB writes (read-only)
 *   - Skips sent-digest idempotency checks (always runs)
 *   - Returns structured data rather than sending via Signal
 *   - Exposes the "unsent candidate pool" size for transparency
 */

import type { Db } from '../db.js';
import { selectDailyByTrack, type SelectedPaper, type DailySelection } from '../digest/select.js';

export interface PreviewOptions {
  /** Max papers per digest (mirrors daily config). Default: 10 */
  maxItemsPerDigest?: number;
  /** Max papers per track (mirrors daily config). Default: 3 */
  maxPerTrack?: number;
  /**
   * Dedup window in days — papers sent within this window won't reappear.
   * Default: 7 (same as daily pipeline).
   */
  dedupDays?: number;
  /**
   * Only include papers with this track name (case-insensitive substring).
   * Default: all tracks.
   */
  trackFilter?: string;
}

export interface PreviewPaper {
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

export interface PreviewResult {
  /** Papers the daily digest would include, grouped by track. */
  byTrack: Map<string, PreviewPaper[]>;
  /** Total candidate papers in queue (before maxItems cap). */
  candidateCount: number;
  /** Total papers that would be sent. */
  selectedCount: number;
  /** Number of tracks represented. */
  trackCount: number;
  /** ISO date string used (today). */
  previewDate: string;
  /** Whether the queue looks healthy (≥1 paper). */
  hasContent: boolean;
}

/**
 * Run a dry-run of the daily digest selection and return structured preview data.
 * No writes to DB.
 */
export function digestPreview(db: Db, opts: PreviewOptions = {}): PreviewResult {
  const {
    maxItemsPerDigest = 10,
    maxPerTrack = 3,
    dedupDays = 7,
    trackFilter,
  } = opts;

  // Run the real selection pipeline (it is read-only — no DB writes)
  const selection: DailySelection = selectDailyByTrack(db, {
    maxItemsPerDigest,
    maxPerTrack,
    dedupDays,
  });

  // Count total candidates before the cap (for transparency).
  // We do a second, uncapped query to get the raw pool size.
  const rawCandidateCount = getCandidateCount(db, dedupDays);

  // Apply optional track filter
  let byTrack = selection.byTrack;
  if (trackFilter) {
    const needle = trackFilter.toLowerCase();
    const filtered = new Map<string, PreviewPaper[]>();
    for (const [track, papers] of byTrack) {
      if (track.toLowerCase().includes(needle)) {
        filtered.set(track, papers);
      }
    }
    byTrack = filtered;
  }

  const selectedCount = Array.from(byTrack.values()).reduce((s, ps) => s + ps.length, 0);

  return {
    byTrack,
    candidateCount: rawCandidateCount,
    selectedCount,
    trackCount: byTrack.size,
    previewDate: new Date().toISOString().slice(0, 10),
    hasContent: selectedCount > 0,
  };
}

/**
 * Count all papers eligible for the next digest (not yet sent, not deduped),
 * without applying any per-track or total caps.
 */
function getCandidateCount(db: Db, dedupDays: number): number {
  const row = db.sqlite
    .prepare(
      `SELECT COUNT(DISTINCT p.arxiv_id) as n
       FROM track_matches tm
       JOIN papers p ON p.arxiv_id = tm.arxiv_id
       LEFT JOIN llm_scores ls ON ls.arxiv_id = p.arxiv_id
       WHERE NOT EXISTS (
         SELECT 1 FROM digest_papers dp
         WHERE dp.arxiv_id = p.arxiv_id
           AND dp.digest_date >= date('now', ? || ' days')
       )
       AND (ls.relevance_score IS NULL OR ls.relevance_score > 2)`
    )
    .get(`-${dedupDays}`) as { n: number };
  return row.n;
}

// ── Formatting ────────────────────────────────────────────────────────────

/**
 * Format the preview as a Signal-ready text block.
 * Mirrors the style of the real daily digest header + per-track messages,
 * but prefixes everything with "PREVIEW" markers so it's obvious this
 * hasn't been sent.
 */
export function formatPreviewMessage(result: PreviewResult): string {
  const lines: string[] = [];

  lines.push(`🔭 Digest preview — ${result.previewDate}`);
  lines.push(`${result.candidateCount} candidates in queue → ${result.selectedCount} would be selected across ${result.trackCount} track(s)`);

  if (!result.hasContent) {
    lines.push('');
    lines.push('📭 Nothing to preview — queue is empty or all eligible papers have already been sent.');
    lines.push('');
    lines.push('Possible reasons:');
    lines.push('  • No new papers ingested yet (run the daily fetch)');
    lines.push('  • All recent papers already sent within the dedup window');
    lines.push('  • No papers scored above the LLM threshold (> 2/5)');
    return lines.join('\n');
  }

  lines.push('');

  for (const [track, papers] of result.byTrack) {
    lines.push(`📂 ${track} (${papers.length})`);
    for (const p of papers) {
      lines.push(`  • ${p.title}`);
      const meta: string[] = [];
      if (p.llmScore !== null) meta.push(`relevance: ${p.llmScore}/5`);
      if (p.matchedTerms.length) meta.push(`matched: ${p.matchedTerms.slice(0, 3).join(', ')}`);
      if (meta.length) lines.push(`    ${meta.join(' • ')}`);
      if (p.absUrl) lines.push(`    ${p.absUrl}`);
      lines.push(`    ${snippet(p.abstract, 200)}`);
    }
    lines.push('');
  }

  lines.push('───');
  lines.push('This is a preview — nothing has been marked as sent.');

  return lines.join('\n').trim();
}

/**
 * Format a compact one-liner preview summary (for inline replies).
 */
export function formatPreviewSummary(result: PreviewResult): string {
  if (!result.hasContent) {
    return `🔭 Preview (${result.previewDate}): queue empty — 0 papers would be selected.`;
  }

  const trackBreakdown = Array.from(result.byTrack.entries())
    .map(([t, ps]) => `${t}: ${ps.length}`)
    .join(', ');

  return `🔭 Preview (${result.previewDate}): ${result.selectedCount}/${result.candidateCount} candidates → [${trackBreakdown}]`;
}

function snippet(s: string, maxLen = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).replace(/\s+\S*$/g, '') + '…';
}
