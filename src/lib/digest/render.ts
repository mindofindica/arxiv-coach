import { truncateForSignal } from './truncate.js';
import type { SelectedPaper } from './select.js';

export function renderDailyMarkdown(dateIso: string, grouped: Map<string, SelectedPaper[]>): string {
  const lines: string[] = [];
  lines.push(`# arxiv-coach daily digest — ${dateIso}`);
  lines.push('');

  for (const [track, papers] of grouped) {
    lines.push(`## ${track}`);
    lines.push('');
    for (const p of papers) {
      lines.push(`- **${p.title}**`);
      if (p.absUrl) lines.push(`  - ${p.absUrl}`);
      const scoreParts: string[] = [`score: ${p.score}`];
      if (p.llmScore !== null) scoreParts.push(`relevance: ${p.llmScore}/5`);
      if (p.matchedTerms.length) scoreParts.push(`matched: ${p.matchedTerms.join(', ')}`);
      lines.push(`  - ${scoreParts.join(' • ')}`);
      lines.push(`  - ${snippet(p.abstract)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderTrackSignalMessage(track: string, papers: SelectedPaper[]): { text: string; truncated: boolean } {
  const lines: string[] = [];
  lines.push(`Daily digest — ${track}`);
  lines.push('');

  for (const p of papers) {
    lines.push(`• ${p.title}`);
    if (p.absUrl) lines.push(`  ${p.absUrl}`);
    const metaParts: string[] = [];
    if (p.llmScore !== null) metaParts.push(`relevance: ${p.llmScore}/5`);
    if (p.matchedTerms.length) metaParts.push(`matched: ${p.matchedTerms.join(', ')}`);
    if (metaParts.length) lines.push(`  ${metaParts.join(' • ')}`);
    lines.push(`  ${snippet(p.abstract, 260)}`);
    lines.push('');
  }

  return truncateForSignal(lines.join('\n').trim());
}

export function renderHeaderSignalMessage(dateIso: string, grouped: Map<string, SelectedPaper[]>): { text: string; truncated: boolean } {
  const totalTracks = grouped.size;
  const totalItems = Array.from(grouped.values()).reduce((s, l) => s + l.length, 0);

  const lines: string[] = [];
  lines.push(`arxiv-coach — daily digest (${dateIso})`);

  if (totalItems === 0) {
    lines.push('No matching papers today across your tracks.');
    lines.push('');
    lines.push("Tip: you can ask for a 'background builder' paper if you want to keep momentum.");
    return truncateForSignal(lines.join('\n'));
  }

  lines.push(`${totalItems} papers across ${totalTracks} track(s).`);
  lines.push('');
  for (const [track, papers] of grouped) {
    lines.push(`• ${track}: ${papers.length}`);
  }

  return truncateForSignal(lines.join('\n'));
}

function snippet(s: string, maxLen = 420): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1).replace(/\s+\S*$/g, '') + '…';
}
