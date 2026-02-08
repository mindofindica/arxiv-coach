import { describe, expect, it } from 'vitest';
import { matchTrack } from './match.js';
import type { TrackConfig } from './types.js';

function track(overrides: Partial<TrackConfig> = {}): TrackConfig {
  return {
    name: 'T',
    enabled: true,
    categories: [],
    phrases: [],
    keywords: [],
    exclude: [],
    threshold: 0,
    maxPerDay: 2,
    ...overrides,
  };
}

describe('matchTrack', () => {
  it('scores phrases (+3) and keywords (+1)', () => {
    const t = track({ phrases: ['function calling'], keywords: ['agent'] });
    const m = matchTrack(t, 'New agent method', 'We study function calling for tools.');
    expect(m.score).toBe(4);
    expect(m.matchedTerms.sort()).toEqual(['agent', 'function calling'].sort());
  });

  it('does whole-word match for keywords', () => {
    const t = track({ keywords: ['rag'] });
    expect(matchTrack(t, 'RAG is cool', '').score).toBe(1);
    expect(matchTrack(t, 'Ragtime music', '').score).toBe(0);
  });

  it('exclude terms short-circuit to no match', () => {
    const t = track({ keywords: ['agent'], exclude: ['robotics'] });
    const m = matchTrack(t, 'Agent', 'Robotics agent');
    expect(m.score).toBe(0);
    expect(m.matchedTerms).toEqual([]);
  });
});
