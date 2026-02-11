import type { KnowledgeGap } from './repo.js';

export interface PaperMatchInput {
  title: string;
  abstract: string;
}

export interface GapMatch {
  gap: KnowledgeGap;
  matchedIn: ('title' | 'abstract')[];
  matchPositions: { field: string; start: number; end: number; text: string }[];
}

/**
 * Check if any active gaps match the given paper (title + abstract).
 * Uses case-insensitive substring matching.
 * 
 * @param gaps - List of active knowledge gaps to check
 * @param paper - Paper with title and abstract
 * @returns Array of matched gaps with match details
 */
export function matchGapsToPlaper(gaps: KnowledgeGap[], paper: PaperMatchInput): GapMatch[] {
  const matches: GapMatch[] = [];

  for (const gap of gaps) {
    const conceptLower = gap.concept.toLowerCase();
    const titleLower = paper.title.toLowerCase();
    const abstractLower = paper.abstract.toLowerCase();

    const matchedIn: ('title' | 'abstract')[] = [];
    const matchPositions: { field: string; start: number; end: number; text: string }[] = [];

    // Check title
    const titleIndex = titleLower.indexOf(conceptLower);
    if (titleIndex !== -1) {
      matchedIn.push('title');
      matchPositions.push({
        field: 'title',
        start: titleIndex,
        end: titleIndex + conceptLower.length,
        text: paper.title.substring(titleIndex, titleIndex + conceptLower.length),
      });
    }

    // Check abstract
    const abstractIndex = abstractLower.indexOf(conceptLower);
    if (abstractIndex !== -1) {
      matchedIn.push('abstract');
      matchPositions.push({
        field: 'abstract',
        start: abstractIndex,
        end: abstractIndex + conceptLower.length,
        text: paper.abstract.substring(abstractIndex, abstractIndex + conceptLower.length),
      });
    }

    if (matchedIn.length > 0) {
      matches.push({
        gap,
        matchedIn,
        matchPositions,
      });
    }
  }

  return matches;
}

/**
 * Check if a single gap matches a paper.
 */
export function gapMatchesPaper(gap: KnowledgeGap, paper: PaperMatchInput): boolean {
  const conceptLower = gap.concept.toLowerCase();
  const titleLower = paper.title.toLowerCase();
  const abstractLower = paper.abstract.toLowerCase();

  return titleLower.includes(conceptLower) || abstractLower.includes(conceptLower);
}
