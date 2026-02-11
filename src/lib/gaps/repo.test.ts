import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type Db } from '../db.js';
import {
  createGap,
  createLearningSession,
  getByStatus,
  getGap,
  getLearningSession,
  listGaps,
  markUnderstood,
  updateGapStatus,
} from './repo.js';

describe('gaps/repo', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-coach-gaps-'));
    db = openDb(path.join(tmpDir, 'test.sqlite'));
    migrate(db);
  });

  afterEach(() => {
    db.sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPaper(arxivId: string, title: string) {
    db.sqlite
      .prepare(
        `INSERT INTO papers (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
         VALUES (?, ?, '', '[]', '[]', ?, ?, '', '', '', ?)`
      )
      .run(arxivId, title, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  }

  describe('createGap', () => {
    it('creates a gap with required fields', () => {
      const gap = createGap(db, {
        concept: 'Chain-of-Thought',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      expect(gap.id).toBeDefined();
      expect(gap.concept).toBe('Chain-of-Thought');
      expect(gap.sourceType).toBe('manual');
      expect(gap.status).toBe('identified');
      expect(gap.priority).toBe(50);
      expect(gap.tags).toEqual([]);
    });

    it('creates a gap with optional fields', () => {
      const gap = createGap(db, {
        concept: 'Tree Search',
        context: 'Mentioned in a paper about LLM reasoning',
        sourceType: 'paper',
        sourceId: 'some-id',
        detectionMethod: 'question_pattern',
        originalMessage: 'What is tree search?',
        priority: 75,
        tags: ['reasoning', 'search'],
      });

      expect(gap.concept).toBe('Tree Search');
      expect(gap.context).toBe('Mentioned in a paper about LLM reasoning');
      expect(gap.sourceType).toBe('paper');
      expect(gap.sourceId).toBe('some-id');
      expect(gap.priority).toBe(75);
      expect(gap.tags).toEqual(['reasoning', 'search']);
    });

    it('fetches paper title when arxivId provided', () => {
      seedPaper('2501.001', 'Agent Memory Systems');

      const gap = createGap(db, {
        concept: 'Memory',
        sourceType: 'paper',
        arxivId: '2501.001',
        detectionMethod: 'signal_command',
      });

      expect(gap.arxivId).toBe('2501.001');
      expect(gap.paperTitle).toBe('Agent Memory Systems');
    });

    it('handles missing paper gracefully', () => {
      const gap = createGap(db, {
        concept: 'Memory',
        sourceType: 'paper',
        arxivId: '9999.999',
        detectionMethod: 'signal_command',
      });

      expect(gap.arxivId).toBe('9999.999');
      expect(gap.paperTitle).toBeNull();
    });
  });

  describe('getGap', () => {
    it('returns a gap by ID', () => {
      const created = createGap(db, {
        concept: 'RLHF',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const fetched = getGap(db, created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.concept).toBe('RLHF');
    });

    it('returns null for non-existent ID', () => {
      const result = getGap(db, 'non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('listGaps', () => {
    it('returns all gaps ordered by priority and date', () => {
      createGap(db, {
        concept: 'Low Priority',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
        priority: 30,
      });

      createGap(db, {
        concept: 'High Priority',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
        priority: 80,
      });

      const gaps = listGaps(db);
      expect(gaps).toHaveLength(2);
      expect(gaps[0]!.concept).toBe('High Priority');
      expect(gaps[1]!.concept).toBe('Low Priority');
    });

    it('filters by status', () => {
      createGap(db, {
        concept: 'Gap 1',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const gap2 = createGap(db, {
        concept: 'Gap 2',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      markUnderstood(db, gap2.id);

      const identified = listGaps(db, { status: 'identified' });
      expect(identified).toHaveLength(1);
      expect(identified[0]!.concept).toBe('Gap 1');

      const understood = listGaps(db, { status: 'understood' });
      expect(understood).toHaveLength(1);
      expect(understood[0]!.concept).toBe('Gap 2');
    });

    it('respects limit', () => {
      for (let i = 1; i <= 5; i++) {
        createGap(db, {
          concept: `Gap ${i}`,
          sourceType: 'manual',
          detectionMethod: 'signal_command',
        });
      }

      const limited = listGaps(db, { limit: 3 });
      expect(limited).toHaveLength(3);
    });
  });

  describe('getByStatus', () => {
    it('returns gaps matching any of the given statuses', () => {
      const gap1 = createGap(db, {
        concept: 'Gap 1',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const gap2 = createGap(db, {
        concept: 'Gap 2',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      updateGapStatus(db, gap2.id, 'lesson_queued');

      const active = getByStatus(db, ['identified', 'lesson_queued']);
      expect(active).toHaveLength(2);
      expect(active.map((g) => g.concept).sort()).toEqual(['Gap 1', 'Gap 2']);
    });

    it('returns empty array for empty status list', () => {
      createGap(db, {
        concept: 'Gap 1',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const result = getByStatus(db, []);
      expect(result).toEqual([]);
    });
  });

  describe('markUnderstood', () => {
    it('updates status to understood', () => {
      const gap = createGap(db, {
        concept: 'Prompt Engineering',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      markUnderstood(db, gap.id);

      const updated = getGap(db, gap.id);
      expect(updated!.status).toBe('understood');
      expect(updated!.markedUnderstoodAt).toBeDefined();
    });
  });

  describe('updateGapStatus', () => {
    it('updates status only', () => {
      const gap = createGap(db, {
        concept: 'RAG',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      updateGapStatus(db, gap.id, 'lesson_queued');

      const updated = getGap(db, gap.id);
      expect(updated!.status).toBe('lesson_queued');
      expect(updated!.lessonGeneratedAt).toBeNull();
      expect(updated!.lessonSentAt).toBeNull();
    });

    it('updates status and timestamps', () => {
      const gap = createGap(db, {
        concept: 'RAG',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const now = new Date().toISOString();
      updateGapStatus(db, gap.id, 'lesson_sent', {
        lessonGeneratedAt: now,
        lessonSentAt: now,
      });

      const updated = getGap(db, gap.id);
      expect(updated!.status).toBe('lesson_sent');
      expect(updated!.lessonGeneratedAt).toBe(now);
      expect(updated!.lessonSentAt).toBe(now);
    });
  });

  describe('createLearningSession', () => {
    it('creates a session with required fields', () => {
      const gap = createGap(db, {
        concept: 'CoT',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const session = createLearningSession(db, {
        gapId: gap.id,
        lessonType: 'micro',
        lessonContent: 'CoT is a technique...',
      });

      expect(session.id).toBeDefined();
      expect(session.gapId).toBe(gap.id);
      expect(session.lessonType).toBe('micro');
      expect(session.lessonContent).toBe('CoT is a technique...');
      expect(session.deliveredVia).toBeNull();
      expect(session.read).toBe(0);
    });

    it('creates a session with optional fields', () => {
      const gap = createGap(db, {
        concept: 'CoT',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const session = createLearningSession(db, {
        gapId: gap.id,
        lessonType: 'micro',
        lessonContent: 'CoT is a technique...',
        deliveredVia: 'signal',
        generationModel: 'sonnet',
      });

      expect(session.deliveredVia).toBe('signal');
      expect(session.generationModel).toBe('sonnet');
    });
  });

  describe('getLearningSession', () => {
    it('returns a session by ID', () => {
      const gap = createGap(db, {
        concept: 'CoT',
        sourceType: 'manual',
        detectionMethod: 'signal_command',
      });

      const created = createLearningSession(db, {
        gapId: gap.id,
        lessonType: 'micro',
        lessonContent: 'Content',
      });

      const fetched = getLearningSession(db, created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.gapId).toBe(gap.id);
    });

    it('returns null for non-existent ID', () => {
      const result = getLearningSession(db, 'non-existent-id');
      expect(result).toBeNull();
    });
  });
});
