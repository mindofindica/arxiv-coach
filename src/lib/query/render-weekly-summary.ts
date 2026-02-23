import { truncateForSignal } from '../digest/truncate.js';
import type { WeeklySummary } from './weekly-summary.js';

/**
 * Score emoji for LLM relevance scores (1-5).
 * 5 = must-read, 1 = marginal.
 */
function llmScoreEmoji(score: number): string {
  if (score >= 5) return '🔥';
  if (score >= 4) return '⭐';
  if (score >= 3) return '📌';
  return '·';
}

/**
 * Format a top paper line for Signal.
 * Shows title, score indicator, tracks, and optional URL.
 */
function formatTopPaper(
  paper: WeeklySummary['topPapers'][number],
  index: number
): string[] {
  const lines: string[] = [];
  const scoreStr = paper.llmScore !== null
    ? `${llmScoreEmoji(paper.llmScore)} LLM:${paper.llmScore}/5`
    : `kw:${paper.keywordScore}`;

  lines.push(`${index + 1}. ${paper.title}`);
  lines.push(`   ${scoreStr} • ${paper.tracks.join(', ')}`);
  if (paper.absUrl) {
    lines.push(`   ${paper.absUrl}`);
  }
  return lines;
}

/**
 * Render a /weekly summary as a Signal-ready message.
 *
 * @param summary  The weekly summary data
 * @returns        { text, truncated }
 */
export function renderWeeklySummaryMessage(
  summary: WeeklySummary
): { text: string; truncated: boolean } {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`arxiv-coach — week ${summary.weekIso}`);
  lines.push(`${summary.dateRange.start} → ${summary.dateRange.end}`);
  lines.push('');

  // ── Total ─────────────────────────────────────────────────────────────────
  if (summary.totalPapers === 0) {
    lines.push('📭 No papers matched your tracks this week.');
    return truncateForSignal(lines.join('\n'));
  }

  lines.push(
    `📥 ${summary.totalPapers} paper${summary.totalPapers === 1 ? '' : 's'} matched this week`
  );
  lines.push('');

  // ── Per-track breakdown ───────────────────────────────────────────────────
  if (summary.trackStats.length > 0) {
    lines.push('Tracks:');
    for (const track of summary.trackStats) {
      const llmPart = track.topLlmScore !== null
        ? ` (best LLM: ${track.topLlmScore}/5)`
        : '';
      lines.push(`  ${track.trackName}: ${track.count} paper${track.count === 1 ? '' : 's'}${llmPart}`);
    }
    lines.push('');
  }

  // ── Top papers ────────────────────────────────────────────────────────────
  if (summary.topPapers.length > 0) {
    const hasLlm = summary.topPapers.some(p => p.llmScore !== null);
    lines.push(hasLlm ? 'Top picks (LLM-ranked):' : 'Top picks (keyword score):');
    lines.push('');
    for (let i = 0; i < summary.topPapers.length; i++) {
      const paperLines = formatTopPaper(summary.topPapers[i]!, i);
      lines.push(...paperLines);
      lines.push('');
    }
  }

  // ── Deep dive status ──────────────────────────────────────────────────────
  if (summary.deepDive.sent && summary.deepDive.title) {
    lines.push(`📖 Weekly deep dive: sent`);
    lines.push(`   "${summary.deepDive.title}"`);
  } else if (!summary.deepDive.sent) {
    lines.push(`📖 Weekly deep dive: not yet sent for ${summary.weekIso}`);
  }

  return truncateForSignal(lines.join('\n'));
}

/**
 * Render a compact one-line status for testing / simple checks.
 */
export function renderWeeklySummaryCompact(summary: WeeklySummary): string {
  if (summary.totalPapers === 0) {
    return `${summary.weekIso}: no papers matched`;
  }
  const deepDivePart = summary.deepDive.sent ? ', deep dive sent' : '';
  return `${summary.weekIso}: ${summary.totalPapers} papers across ${summary.trackStats.length} track${summary.trackStats.length === 1 ? '' : 's'}${deepDivePart}`;
}
