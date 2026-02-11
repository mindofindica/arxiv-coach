import { describe, expect, it } from 'vitest';
import { gapMatchesPaper, matchGapsToPlaper, type GapMatch } from './match.js';
import type { KnowledgeGap } from './repo.js';

describe('gaps/match', () => {
  const mockGap = (concept: string): KnowledgeGap => ({
    id: 'test-id',
    createdAt: '2026-02-11T00:00:00Z',
    concept,
    context: null,
    sourceType: 'manual',
    sourceId: null,
    paperTitle: null,
    arxivId: null,
    detectionMethod: 'signal_command',
    originalMessage: null,
    status: 'identified',
    priority: 50,
    lessonGeneratedAt: null,
    lessonSentAt: null,
    markedUnderstoodAt: null,
    tags: [],
  });

  describe('matchGapsToPlaper', () => {
    it('matches concept in title (exact case)', () => {
      const gaps = [mockGap('Chain-of-Thought')];
      const paper = {
        title: 'Chain-of-Thought Reasoning in LLMs',
        abstract: 'This paper explores reasoning techniques.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.gap.concept).toBe('Chain-of-Thought');
      expect(matches[0]!.matchedIn).toContain('title');
      expect(matches[0]!.matchPositions).toHaveLength(1);
      expect(matches[0]!.matchPositions[0]!.field).toBe('title');
      expect(matches[0]!.matchPositions[0]!.text).toBe('Chain-of-Thought');
    });

    it('matches concept in title (case insensitive)', () => {
      const gaps = [mockGap('chain-of-thought')];
      const paper = {
        title: 'Understanding Chain-of-Thought Prompting',
        abstract: 'This paper explores reasoning.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedIn).toContain('title');
    });

    it('matches concept in abstract', () => {
      const gaps = [mockGap('tree search')];
      const paper = {
        title: 'Novel Reasoning Methods',
        abstract: 'We introduce a new tree search algorithm for LLM reasoning.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedIn).toContain('abstract');
      expect(matches[0]!.matchPositions[0]!.field).toBe('abstract');
    });

    it('matches concept in both title and abstract', () => {
      const gaps = [mockGap('RLHF')];
      const paper = {
        title: 'RLHF for LLM Alignment',
        abstract: 'We analyze RLHF techniques across multiple models.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.matchedIn).toHaveLength(2);
      expect(matches[0]!.matchedIn).toContain('title');
      expect(matches[0]!.matchedIn).toContain('abstract');
      expect(matches[0]!.matchPositions).toHaveLength(2);
    });

    it('matches multiple gaps', () => {
      const gaps = [mockGap('RAG'), mockGap('vector database')];
      const paper = {
        title: 'RAG Systems with Vector Databases',
        abstract: 'We explore retrieval systems.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.gap.concept).sort()).toEqual(['RAG', 'vector database']);
    });

    it('returns empty array when no matches', () => {
      const gaps = [mockGap('quantum computing')];
      const paper = {
        title: 'Chain-of-Thought in LLMs',
        abstract: 'This paper explores reasoning techniques.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toEqual([]);
    });

    it('handles partial word matches', () => {
      const gaps = [mockGap('agent')];
      const paper = {
        title: 'Multi-Agent Systems',
        abstract: 'Agents cooperate to solve tasks.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      // Substring matching means "agent" matches "Agent" in "Multi-Agent" and "Agents"
      expect(matches[0]!.matchedIn).toContain('title');
    });

    it('returns correct match positions', () => {
      const gaps = [mockGap('RAG')];
      const paper = {
        title: 'Understanding RAG Systems',
        abstract: 'Content here.',
      };

      const matches = matchGapsToPlaper(gaps, paper);
      expect(matches).toHaveLength(1);
      const pos = matches[0]!.matchPositions[0]!;
      expect(pos.field).toBe('title');
      expect(pos.start).toBe(14); // Position of "RAG" in "Understanding RAG Systems"
      expect(pos.end).toBe(17);
      expect(pos.text).toBe('RAG');
    });
  });

  describe('gapMatchesPaper', () => {
    it('returns true when concept matches title', () => {
      const gap = mockGap('CoT');
      const paper = {
        title: 'CoT Reasoning',
        abstract: 'Other content',
      };

      expect(gapMatchesPaper(gap, paper)).toBe(true);
    });

    it('returns true when concept matches abstract', () => {
      const gap = mockGap('attention mechanism');
      const paper = {
        title: 'Novel Architecture',
        abstract: 'We improve the attention mechanism for transformers.',
      };

      expect(gapMatchesPaper(gap, paper)).toBe(true);
    });

    it('returns false when concept does not match', () => {
      const gap = mockGap('quantum annealing');
      const paper = {
        title: 'LLM Agents',
        abstract: 'This paper is about agents.',
      };

      expect(gapMatchesPaper(gap, paper)).toBe(false);
    });

    it('is case insensitive', () => {
      const gap = mockGap('neural network');
      const paper = {
        title: 'NEURAL NETWORK Architecture',
        abstract: 'Content',
      };

      expect(gapMatchesPaper(gap, paper)).toBe(true);
    });
  });
});
