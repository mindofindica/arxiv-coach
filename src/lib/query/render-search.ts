/**
 * render-search — Signal-friendly rendering for paper search results
 *
 * Formats a SearchResponse into a compact, scannable Signal message.
 * No markdown tables (Signal doesn't render them). Emoji-coded scores.
 */

import { truncateForSignal } from '../digest/truncate.js';
import type { SearchResponse, SearchResult } from './search-papers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Score emoji for LLM relevance score (1–5).
 */
function scoreEmoji(score: number | null): string {
  if (score === null) return '·';
  if (score >= 5) return '🔥';
  if (score >= 4) return '⭐';
  if (score >= 3) return '📌';
  return '·';
}

/**
 * Format a single result as 3–4 lines for Signal.
 */
function formatResult(result: SearchResult, index: number): string[] {
  const lines: string[] = [];

  const scoreStr = result.llmScore !== null
    ? `${scoreEmoji(result.llmScore)} ${result.llmScore}/5`
    : result.keywordScore > 0
      ? `kw:${result.keywordScore}`
      : '·';

  const tracksStr = result.tracks.length > 0
    ? result.tracks.slice(0, 2).join(', ')
    : 'untracked';

  // Line 1: number + title
  lines.push(`${index + 1}. ${result.title}`);

  // Line 2: score + tracks
  lines.push(`   ${scoreStr} · ${tracksStr}`);

  // Line 3: excerpt (first ~120 chars)
  const shortExcerpt = result.excerpt.length > 120
    ? result.excerpt.slice(0, 117) + '…'
    : result.excerpt;
  lines.push(`   "${shortExcerpt}"`);

  // Line 4: URL
  lines.push(`   ${result.absUrl}`);

  return lines;
}

// ─── Main render ──────────────────────────────────────────────────────────────

/**
 * Render a SearchResponse as a Signal-ready message.
 *
 * @param response  The search response from searchPapers()
 * @returns         { text, truncated }
 */
export function renderSearchMessage(
  response: SearchResponse
): { text: string; truncated: boolean } {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
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

  // ── Results ───────────────────────────────────────────────────────────────
  for (let i = 0; i < response.results.length; i++) {
    const resultLines = formatResult(response.results[i]!, i);
    lines.push(...resultLines);
    if (i < response.results.length - 1) {
      lines.push('');
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push('→ /weekly for this week\'s papers · /reading-list for saved');

  return truncateForSignal(lines.join('\n'));
}

/**
 * Compact single-line summary for testing / debugging.
 */
export function renderSearchCompact(response: SearchResponse): string {
  if (response.count === 0) {
    return `search "${response.query}": no results`;
  }
  const topScore = response.results[0]?.llmScore;
  const scoreStr = topScore !== null && topScore !== undefined ? `, top score ${topScore}/5` : '';
  return `search "${response.query}": ${response.count} result${response.count === 1 ? '' : 's'}${scoreStr}`;
}
