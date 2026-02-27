/**
 * Render recommend output as a Signal-friendly message.
 */

import type { RecommendOutput } from './recommend-papers.js';

const SCORE_EMOJI: Record<number, string> = {
  5: '🔥',
  4: '⭐',
  3: '📌',
  2: '📄',
  1: '📄',
};

function scoreEmoji(score: number | null): string {
  if (score === null) return '📄';
  return SCORE_EMOJI[Math.round(score)] ?? '📄';
}

function shortTitle(title: string, max = 60): string {
  return title.length <= max ? title : title.slice(0, max - 1) + '…';
}

function formatDate(iso: string): string {
  // "2026-01-15" → "Jan 15"
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isRecommendResponse(output: RecommendOutput): output is Extract<RecommendOutput, { kind: 'recommendations' }> {
  return output.kind === 'recommendations';
}

export function renderRecommendMessage(output: RecommendOutput): string {
  if (output.kind === 'noSignal') {
    return `🤷 ${output.message}`;
  }

  if (output.kind === 'noResults') {
    return `🏆 ${output.message}`;
  }

  if (!isRecommendResponse(output)) {
    return `🤷 Could not generate recommendations.`;
  }

  const { signalCount, keyTerms, results } = output;

  const lines: string[] = [
    `🎯 Based on your ${signalCount} saved/loved paper${signalCount === 1 ? '' : 's'}:`,
    `Topics: ${keyTerms.join(', ')}`,
    '',
  ];

  for (const [i, r] of results.entries()) {
    const emoji = scoreEmoji(r.llmScore);
    const score = r.llmScore !== null ? `${r.llmScore}/5` : 'unscored';
    const track = r.tracks.length > 0 ? ` · ${r.tracks[0]}` : '';
    const date = formatDate(r.publishedAt);
    const matchNote =
      r.matchedTerms.length > 0 ? ` (${r.matchedTerms.join(', ')})` : '';

    lines.push(`${i + 1}. ${emoji} ${shortTitle(r.title)}`);
    lines.push(`   ${score}${track} · ${date}${matchNote}`);
    lines.push(`   arxiv:${r.arxivId}`);
    if (i < results.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('Send /save <id> to add to reading list.');

  return lines.join('\n');
}
