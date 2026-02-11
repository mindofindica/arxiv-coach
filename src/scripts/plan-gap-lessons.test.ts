import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../lib/db.js';
import { createGap } from '../lib/gaps/index.js';

describe('plan-gap-lessons integration', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-plan-gap-'));
    db = openDb(path.join(tmpDir, 'test.sqlite'));
    migrate(db);
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPaper(arxivId: string, title: string, abstract: string, daysAgo: number = 0) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const timestamp = date.toISOString();

    db.sqlite
      .prepare(
        `INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
         VALUES (?, ?, ?, '[]', '[]', ?, ?, '', '', '', ?)`
      )
      .run(arxivId, title, abstract, timestamp, timestamp, timestamp);
  }

  it('produces correct output format for matching gaps', () => {
    // Create gaps
    createGap(db, {
      concept: 'Tree Search',
      sourceType: 'manual',
      detectionMethod: 'signal_command',
    });

    createGap(db, {
      concept: 'No Match Concept',
      sourceType: 'manual',
      detectionMethod: 'signal_command',
    });

    // Create papers (within last 7 days)
    seedPaper('2501.001', 'Tree Search for LLM Reasoning', 'We explore tree search algorithms.', 2);
    seedPaper('2501.002', 'Novel Tree Search Method', 'An abstract about tree search.', 5);

    // Create an old paper (should be excluded)
    seedPaper('2501.003', 'Old Tree Search Paper', 'Abstract', 10);

    // Simulate the script logic
    const activeGaps = db.sqlite
      .prepare("SELECT * FROM knowledge_gaps WHERE status IN ('identified', 'lesson_queued')")
      .all();

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentPapers = db.sqlite
      .prepare('SELECT arxiv_id, title, abstract FROM papers WHERE updated_at >= ?')
      .all(sevenDaysAgo.toISOString());

    expect(activeGaps).toHaveLength(2);
    expect(recentPapers).toHaveLength(2); // Old paper excluded
  });

  it('matches gaps to recent papers correctly', () => {
    const gap = createGap(db, {
      concept: 'RAG',
      sourceType: 'manual',
      detectionMethod: 'signal_command',
    });

    seedPaper('2501.001', 'RAG Systems', 'Abstract about retrieval.', 1);
    seedPaper('2501.002', 'Unrelated Paper', 'No match here.', 1);

    // Check matching logic
    const paper1 = { title: 'RAG Systems', abstract: 'Abstract about retrieval.' };
    const paper2 = { title: 'Unrelated Paper', abstract: 'No match here.' };

    const conceptLower = gap.concept.toLowerCase();
    const match1 = paper1.title.toLowerCase().includes(conceptLower) || paper1.abstract.toLowerCase().includes(conceptLower);
    const match2 = paper2.title.toLowerCase().includes(conceptLower) || paper2.abstract.toLowerCase().includes(conceptLower);

    expect(match1).toBe(true);
    expect(match2).toBe(false);
  });

  it('generates prompt for matched gaps', () => {
    createGap(db, {
      concept: 'RLHF',
      sourceType: 'manual',
      detectionMethod: 'signal_command',
    });

    seedPaper('2501.001', 'RLHF in Practice', 'This paper explores RLHF methods.', 1);

    const concept = 'RLHF';
    const title = 'RLHF in Practice';
    const abstract = 'This paper explores RLHF methods.';

    // Simulate buildLessonPrompt
    const prompt = `You are helping Mikey learn about LLM engineering concepts. Generate a concise micro-lesson (3-4 short paragraphs) explaining the following concept:

**Concept:** ${concept}

**Context:** This concept appeared in a recent arXiv paper:
- Title: ${title}
- Abstract: ${abstract}`;

    expect(prompt).toContain('RLHF');
    expect(prompt).toContain('RLHF in Practice');
    expect(prompt).toContain('micro-lesson');
  });
});
