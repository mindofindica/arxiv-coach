import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.js';
import { countScoredPapers, getScore, getUnscoredPapers, upsertScore, upsertScores, type LlmScore } from './repo.js';

describe('scoring/repo', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-scoring-'));
    db = openDb(path.join(tmpDir, 'test.sqlite'));
    migrate(db);
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPaper(arxivId: string, title: string, abstract: string) {
    db.sqlite.prepare(
      `INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, ?, ?, '[]', '[]', ?, ?, '', '', '', ?)`
    ).run(arxivId, title, abstract, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  }

  function seedTrackMatch(arxivId: string, trackName: string, score: number) {
    db.sqlite.prepare(
      `INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '["term1"]', ?)`
    ).run(arxivId, trackName, score, new Date().toISOString());
  }

  function seedScore(arxivId: string, relevanceScore: number) {
    db.sqlite.prepare(
      `INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, model, scored_at)
       VALUES (?, ?, 'test reasoning', 'sonnet', ?)`
    ).run(arxivId, relevanceScore, new Date().toISOString());
  }

  describe('getUnscoredPapers', () => {
    it('returns papers with track matches but no llm_score', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedTrackMatch('2501.001', 'Track1', 5);

      const result = getUnscoredPapers(db);
      expect(result).toHaveLength(1);
      const paper = result[0]!;
      expect(paper.arxivId).toBe('2501.001');
      expect(paper.title).toBe('Paper A');
      expect(paper.abstract).toBe('Abstract A');
      expect(paper.keywordScore).toBe(5);
      expect(paper.tracks).toEqual(['Track1']);
    });

    it('excludes already-scored papers', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedPaper('2501.002', 'Paper B', 'Abstract B');
      seedTrackMatch('2501.001', 'Track1', 5);
      seedTrackMatch('2501.002', 'Track1', 4);
      seedScore('2501.001', 4);

      const result = getUnscoredPapers(db);
      expect(result).toHaveLength(1);
      expect(result[0]!.arxivId).toBe('2501.002');
    });

    it('returns correct track aggregation', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedTrackMatch('2501.001', 'Track1', 5);
      seedTrackMatch('2501.001', 'Track2', 3);

      const result = getUnscoredPapers(db);
      expect(result).toHaveLength(1);
      const paper = result[0]!;
      expect(paper.tracks).toHaveLength(2);
      expect(paper.tracks).toContain('Track1');
      expect(paper.tracks).toContain('Track2');
      // Should return max score
      expect(paper.keywordScore).toBe(5);
    });

    it('returns empty array when no unscored papers', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedTrackMatch('2501.001', 'Track1', 5);
      seedScore('2501.001', 4);

      const result = getUnscoredPapers(db);
      expect(result).toHaveLength(0);
    });

    it('excludes papers without track matches', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      // No track match

      const result = getUnscoredPapers(db);
      expect(result).toHaveLength(0);
    });
  });

  describe('upsertScore', () => {
    it('inserts new score', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');

      const score: LlmScore = {
        arxivId: '2501.001',
        relevanceScore: 4,
        reasoning: 'Directly about LLM agents',
        model: 'sonnet',
        scoredAt: '2026-02-09T10:00:00Z',
      };

      upsertScore(db, score);

      const stored = getScore(db, '2501.001');
      expect(stored).not.toBeNull();
      expect(stored!.relevanceScore).toBe(4);
      expect(stored!.reasoning).toBe('Directly about LLM agents');
      expect(stored!.model).toBe('sonnet');
    });

    it('updates existing score (upsert)', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');

      const score1: LlmScore = {
        arxivId: '2501.001',
        relevanceScore: 3,
        reasoning: 'Initial reasoning',
        model: 'sonnet',
        scoredAt: '2026-02-09T10:00:00Z',
      };
      upsertScore(db, score1);

      const score2: LlmScore = {
        arxivId: '2501.001',
        relevanceScore: 5,
        reasoning: 'Updated reasoning',
        model: 'opus',
        scoredAt: '2026-02-09T11:00:00Z',
      };
      upsertScore(db, score2);

      const stored = getScore(db, '2501.001');
      expect(stored!.relevanceScore).toBe(5);
      expect(stored!.reasoning).toBe('Updated reasoning');
      expect(stored!.model).toBe('opus');
    });
  });

  describe('upsertScores', () => {
    it('batch insert with transaction', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedPaper('2501.002', 'Paper B', 'Abstract B');
      seedPaper('2501.003', 'Paper C', 'Abstract C');

      const scores: LlmScore[] = [
        { arxivId: '2501.001', relevanceScore: 5, reasoning: 'R1', model: 'sonnet', scoredAt: '2026-02-09T10:00:00Z' },
        { arxivId: '2501.002', relevanceScore: 3, reasoning: 'R2', model: 'sonnet', scoredAt: '2026-02-09T10:00:00Z' },
        { arxivId: '2501.003', relevanceScore: 1, reasoning: 'R3', model: 'sonnet', scoredAt: '2026-02-09T10:00:00Z' },
      ];

      upsertScores(db, scores);

      expect(getScore(db, '2501.001')!.relevanceScore).toBe(5);
      expect(getScore(db, '2501.002')!.relevanceScore).toBe(3);
      expect(getScore(db, '2501.003')!.relevanceScore).toBe(1);
      expect(countScoredPapers(db)).toBe(3);
    });

    it('handles empty array', () => {
      upsertScores(db, []);
      expect(countScoredPapers(db)).toBe(0);
    });
  });

  describe('getScore', () => {
    it('returns null for unscored paper', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      expect(getScore(db, '2501.001')).toBeNull();
    });

    it('returns correct score', () => {
      seedPaper('2501.001', 'Paper A', 'Abstract A');
      seedScore('2501.001', 4);

      const result = getScore(db, '2501.001');
      expect(result).not.toBeNull();
      expect(result!.arxivId).toBe('2501.001');
      expect(result!.relevanceScore).toBe(4);
      expect(result!.reasoning).toBe('test reasoning');
      expect(result!.model).toBe('sonnet');
    });
  });
});
