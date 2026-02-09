import { truncateForSignal } from '../digest/truncate.js';
import type { WeeklyCandidate } from './select.js';

/**
 * Render the Saturday shortlist message asking the user to pick a paper.
 */
export function renderShortlistMessage(
  weekIso: string,
  candidates: WeeklyCandidate[]
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(`arxiv-coach — weekly shortlist (${weekIso})`);
  lines.push('');

  if (candidates.length === 0) {
    lines.push('📭 Quiet week — no papers matched your tracks.');
    lines.push('');
    lines.push("I'll skip the deep dive this week unless you want me to pick something from the broader arXiv feed.");
    return truncateForSignal(lines.join('\n'));
  }

  lines.push('🗳️ Top papers this week for the deep dive:');
  lines.push('');

  for (const c of candidates) {
    lines.push(`${c.rank}. ${c.title}`);
    if (c.absUrl) {
      lines.push(`   ${c.absUrl}`);
    }
    lines.push(`   score: ${c.score} • ${c.tracks.join(', ')}`);
    lines.push(`   ${snippet(c.abstract, 200)}`);
    lines.push('');
  }

  lines.push('Reply with a number (1/2/3) to pick, or I\'ll auto-select #1 tomorrow morning.');

  return truncateForSignal(lines.join('\n'));
}

/**
 * Render the header message for the Sunday deep dive delivery.
 */
export function renderWeeklyHeaderMessage(
  weekIso: string,
  paper: {
    title: string;
    absUrl: string | null;
    score: number;
    tracks: string[];
    hasFullText: boolean;
  }
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(`arxiv-coach — weekly deep dive (${weekIso})`);
  lines.push('');
  lines.push(`📖 This week's paper:`);
  lines.push('');
  lines.push(`**${paper.title}**`);
  if (paper.absUrl) {
    lines.push(paper.absUrl);
  }
  lines.push(`score: ${paper.score} • ${paper.tracks.join(', ')}`);
  
  if (!paper.hasFullText) {
    lines.push('');
    lines.push('⚠️ Full text unavailable — this deep dive is based on the abstract only.');
  }

  return truncateForSignal(lines.join('\n'));
}

/**
 * Render the "Related This Week" section message.
 */
export function renderRelatedMessage(
  relatedPapers: Array<{ arxivId: string; title: string; score: number; tracks: string[] }>
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push('📚 Related papers this week:');
  lines.push('');

  if (relatedPapers.length === 0) {
    lines.push('No other papers matched your tracks this week.');
    return truncateForSignal(lines.join('\n'));
  }

  for (const p of relatedPapers.slice(0, 5)) {
    lines.push(`• ${p.title}`);
    lines.push(`  score: ${p.score} • ${p.tracks.slice(0, 2).join(', ')}`);
    lines.push('');
  }

  if (relatedPapers.length > 5) {
    lines.push(`...and ${relatedPapers.length - 5} more.`);
  }

  return truncateForSignal(lines.join('\n'));
}

/**
 * Render the "no papers" message for a quiet week.
 */
export function renderQuietWeekMessage(weekIso: string): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(`arxiv-coach — weekly deep dive (${weekIso})`);
  lines.push('');
  lines.push('📭 No papers matched your tracks this week.');
  lines.push('');
  lines.push("Take a break, or ask me to find something interesting from the broader arXiv feed!");

  return truncateForSignal(lines.join('\n'));
}

function snippet(s: string, maxLen = 200): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).replace(/\s+\S*$/g, '') + '…';
}
