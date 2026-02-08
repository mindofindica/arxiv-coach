import type { TrackConfig } from './types.js';

export interface MatchResult {
  score: number;
  matchedTerms: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function wordMatch(haystack: string, word: string): boolean {
  const w = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}

export function matchTrack(track: TrackConfig, title: string, summary: string): MatchResult {
  const hay = normalize(`${title} ${summary}`);
  let score = 0;
  const matchedTerms: string[] = [];

  for (const ex of track.exclude ?? []) {
    if (!ex) continue;
    if (hay.includes(normalize(ex))) {
      return { score: 0, matchedTerms: [] };
    }
  }

  for (const phrase of track.phrases ?? []) {
    const p = normalize(phrase);
    if (!p) continue;
    if (hay.includes(p)) {
      score += 3;
      matchedTerms.push(phrase);
    }
  }

  for (const kw of track.keywords ?? []) {
    const k = normalize(kw);
    if (!k) continue;
    if (wordMatch(hay, k)) {
      score += 1;
      matchedTerms.push(kw);
    }
  }

  return { score, matchedTerms: Array.from(new Set(matchedTerms)) };
}
