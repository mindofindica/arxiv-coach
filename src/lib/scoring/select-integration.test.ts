import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.js';
import { selectDailyByTrack } from '../digest/select.js';

describe('selectDailyByTrack with LLM scores', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-select-'));
    db = openDb(path.join(tmpDir, 'test.sqlite'));
    migrate(db);
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPaper(arxivId: string, title: string, updatedAt: string = new Date().toISOString()) {
    // Create a fake meta.json so the selection can read URLs
    const metaPath = path.join(tmpDir, `${arxivId}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
      absUrl: `http://arxiv.org/abs/${arxivId}`,
      pdfUrl: `http://arxiv.org/pdf/${arxivId}.pdf`,
    }));

    db.sqlite.prepare(
      `INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, ?, 'Abstract', '[]', '[]', ?, ?, '', '', ?, ?)`
    ).run(arxivId, title, updatedAt, updatedAt, metaPath, new Date().toISOString());
  }

  function seedTrackMatch(arxivId: string, trackName: string, score: number, matchedAt: string = new Date().toISOString()) {
    db.sqlite.prepare(
      `INSERT INTO track_matches (arxiv_id, track_name, score, matched_terms_json, matched_at)
       VALUES (?, ?, ?, '["term"]', ?)`
    ).run(arxivId, trackName, score, matchedAt);
  }

  function seedLlmScore(arxivId: string, relevanceScore: number) {
    db.sqlite.prepare(
      `INSERT INTO llm_scores (arxiv_id, relevance_score, reasoning, model, scored_at)
       VALUES (?, ?, 'Test reasoning', 'sonnet', ?)`
    ).run(arxivId, relevanceScore, new Date().toISOString());
  }

  it('filters out papers with llmScore <= 2', () => {
    seedPaper('2501.001', 'Irrelevant Paper');
    seedPaper('2501.002', 'Relevant Paper');
    seedTrackMatch('2501.001', 'Track1', 5);
    seedTrackMatch('2501.002', 'Track1', 3);
    seedLlmScore('2501.001', 2); // Should be filtered
    seedLlmScore('2501.002', 4); // Should be included

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(1);
    expect(papers[0]!.arxivId).toBe('2501.002');
  });

  it('ranks papers with high llmScore above papers with only keyword scores', () => {
    seedPaper('2501.001', 'Keyword Only');
    seedPaper('2501.002', 'LLM Scored High');
    seedTrackMatch('2501.001', 'Track1', 10); // High keyword score
    seedTrackMatch('2501.002', 'Track1', 3);  // Low keyword score
    seedLlmScore('2501.002', 5); // High LLM score

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(2);
    // LLM scored paper should come first despite lower keyword score
    expect(papers[0]!.arxivId).toBe('2501.002');
    expect(papers[0]!.llmScore).toBe(5);
    expect(papers[1]!.arxivId).toBe('2501.001');
    expect(papers[1]!.llmScore).toBeNull();
  });

  it('includes papers without llmScore (fallback)', () => {
    seedPaper('2501.001', 'Unscored Paper');
    seedTrackMatch('2501.001', 'Track1', 5);
    // No LLM score

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(1);
    expect(papers[0]!.arxivId).toBe('2501.001');
    expect(papers[0]!.llmScore).toBeNull();
  });

  it('respects total cap and per-track cap', () => {
    // Create 6 papers across 2 tracks
    for (let i = 1; i <= 3; i++) {
      seedPaper(`2501.00${i}`, `Track1 Paper ${i}`);
      seedTrackMatch(`2501.00${i}`, 'Track1', 5);
      seedLlmScore(`2501.00${i}`, 4);
    }
    for (let i = 4; i <= 6; i++) {
      seedPaper(`2501.00${i}`, `Track2 Paper ${i}`);
      seedTrackMatch(`2501.00${i}`, 'Track2', 5);
      seedLlmScore(`2501.00${i}`, 4);
    }

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 4, maxPerTrack: 2 });

    expect(result.totals.items).toBe(4);
    const track1 = result.byTrack.get('Track1') ?? [];
    const track2 = result.byTrack.get('Track2') ?? [];
    expect(track1.length).toBeLessThanOrEqual(2);
    expect(track2.length).toBeLessThanOrEqual(2);
  });

  it('orders correctly: llmScore 5 > llmScore 4 > unscored (keyword 5) > llmScore 3', () => {
    seedPaper('2501.001', 'Score 5');
    seedPaper('2501.002', 'Score 4');
    seedPaper('2501.003', 'Score 3');
    seedPaper('2501.004', 'Unscored');

    seedTrackMatch('2501.001', 'Track1', 3);
    seedTrackMatch('2501.002', 'Track1', 3);
    seedTrackMatch('2501.003', 'Track1', 3);
    seedTrackMatch('2501.004', 'Track1', 10); // High keyword score

    seedLlmScore('2501.001', 5);
    seedLlmScore('2501.002', 4);
    seedLlmScore('2501.003', 3);
    // 2501.004 unscored

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 10 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(4);
    expect(papers[0]!.arxivId).toBe('2501.001'); // llmScore 5
    expect(papers[1]!.arxivId).toBe('2501.002'); // llmScore 4
    expect(papers[2]!.arxivId).toBe('2501.003'); // llmScore 3
    expect(papers[3]!.arxivId).toBe('2501.004'); // unscored (ranked after scored)
  });

  it('works when llm_scores table is empty (backwards compatible)', () => {
    seedPaper('2501.001', 'Paper A');
    seedPaper('2501.002', 'Paper B');
    seedTrackMatch('2501.001', 'Track1', 5);
    seedTrackMatch('2501.002', 'Track1', 3);
    // No LLM scores

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(2);
    // Should still order by keyword score
    expect(papers[0]!.arxivId).toBe('2501.001');
    expect(papers[0]!.llmScore).toBeNull();
    expect(papers[1]!.arxivId).toBe('2501.002');
  });

  it('filters llmScore 1 papers', () => {
    seedPaper('2501.001', 'Very Irrelevant');
    seedTrackMatch('2501.001', 'Track1', 5);
    seedLlmScore('2501.001', 1);

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(0);
  });

  it('includes llmScore 3 papers (borderline relevant)', () => {
    seedPaper('2501.001', 'Somewhat Relevant');
    seedTrackMatch('2501.001', 'Track1', 5);
    seedLlmScore('2501.001', 3);

    const result = selectDailyByTrack(db, { maxItemsPerDigest: 10, maxPerTrack: 5 });
    const papers = result.byTrack.get('Track1') ?? [];

    expect(papers).toHaveLength(1);
    expect(papers[0]!.llmScore).toBe(3);
  });
});
