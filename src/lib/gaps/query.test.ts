/**
 * Tests for gaps/query.ts and gaps/render-gaps.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db.js';
import { createGap } from './repo.js';
import { queryGaps } from './query.js';
import { renderGapsReply } from './render-gaps.js';

// ─── Test DB setup ────────────────────────────────────────────────────────────

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = { sqlite };
  migrate(db as any);
  return db;
}

/** Insert a minimal valid paper row */
function insertPaper(db: any, arxivId: string, title: string) {
  const now = new Date().toISOString();
  db.sqlite
    .prepare(
      `INSERT INTO papers
        (arxiv_id, title, abstract, authors_json, categories_json, published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(arxivId, title, 'abstract', '[]', '[]', now, now, '', '', '', now);
}

// ─── queryGaps ────────────────────────────────────────────────────────────────

describe('queryGaps', () => {
  it('returns empty when no gaps exist', () => {
    const db = makeDb() as any;
    const result = queryGaps(db);
    expect(result.gaps).toHaveLength(0);
    expect(result.totalAll).toBe(0);
    expect(result.totalActive).toBe(0);
    expect(result.totalUnderstood).toBe(0);
  });

  it('returns active gaps by default', () => {
    const db = makeDb() as any;
    createGap(db, { concept: 'Speculative Decoding', sourceType: 'paper', detectionMethod: 'auto' });
    createGap(db, { concept: 'LoRA Rank', sourceType: 'paper', detectionMethod: 'auto' });

    const result = queryGaps(db);
    expect(result.gaps).toHaveLength(2);
    expect(result.totalActive).toBe(2);
    expect(result.totalUnderstood).toBe(0);
  });

  it('excludes understood gaps by default', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Old Concept', sourceType: 'paper', detectionMethod: 'auto' });
    db.sqlite.prepare("UPDATE knowledge_gaps SET status = 'understood' WHERE id = ?").run(gap.id);
    createGap(db, { concept: 'New Concept', sourceType: 'paper', detectionMethod: 'auto' });

    const result = queryGaps(db);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.concept).toBe('New Concept');
    expect(result.totalUnderstood).toBe(1);
    expect(result.totalActive).toBe(1);
    expect(result.totalAll).toBe(2);
  });

  it('includes understood gaps when includeUnderstood=true', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Old Concept', sourceType: 'paper', detectionMethod: 'auto' });
    db.sqlite.prepare("UPDATE knowledge_gaps SET status = 'understood' WHERE id = ?").run(gap.id);
    createGap(db, { concept: 'New Concept', sourceType: 'paper', detectionMethod: 'auto' });

    const result = queryGaps(db, { includeUnderstood: true });
    expect(result.gaps).toHaveLength(2);
  });

  it('filters by statusFilter when provided', () => {
    const db = makeDb() as any;
    const gap1 = createGap(db, { concept: 'Understood Concept', sourceType: 'paper', detectionMethod: 'auto' });
    db.sqlite.prepare("UPDATE knowledge_gaps SET status = 'understood' WHERE id = ?").run(gap1.id);
    createGap(db, { concept: 'Active Concept', sourceType: 'paper', detectionMethod: 'auto' });

    const result = queryGaps(db, { statusFilter: 'understood' });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.concept).toBe('Understood Concept');
  });

  it('respects limit option', () => {
    const db = makeDb() as any;
    for (let i = 0; i < 5; i++) {
      createGap(db, { concept: `Concept ${i}`, sourceType: 'paper', detectionMethod: 'auto' });
    }
    const result = queryGaps(db, { limit: 3 });
    expect(result.gaps).toHaveLength(3);
    expect(result.totalActive).toBe(5); // total is still 5
  });

  it('sorts by priority DESC then createdAt DESC', () => {
    const db = makeDb() as any;
    createGap(db, { concept: 'Low Pri', sourceType: 'paper', detectionMethod: 'auto', priority: 10 });
    createGap(db, { concept: 'High Pri', sourceType: 'paper', detectionMethod: 'auto', priority: 80 });
    createGap(db, { concept: 'Mid Pri', sourceType: 'paper', detectionMethod: 'auto', priority: 50 });

    const result = queryGaps(db);
    expect(result.gaps[0]!.concept).toBe('High Pri');
    expect(result.gaps[1]!.concept).toBe('Mid Pri');
    expect(result.gaps[2]!.concept).toBe('Low Pri');
  });

  it('correctly counts lesson_queued status in totalActive', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Queued Lesson', sourceType: 'paper', detectionMethod: 'auto' });
    db.sqlite.prepare("UPDATE knowledge_gaps SET status = 'lesson_queued' WHERE id = ?").run(gap.id);

    const result = queryGaps(db);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.concept).toBe('Queued Lesson');
    expect(result.totalActive).toBe(1);
  });
});

// ─── renderGapsReply ──────────────────────────────────────────────────────────

describe('renderGapsReply', () => {
  it('shows empty state when no gaps exist at all', () => {
    const result = {
      gaps: [],
      totalAll: 0,
      totalActive: 0,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('No knowledge gaps tracked yet');
    expect(reply).toContain('Gaps are detected automatically');
  });

  it('shows no-active-gaps message when all are understood', () => {
    const result = {
      gaps: [],
      totalAll: 3,
      totalActive: 0,
      totalUnderstood: 3,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('No active gaps right now');
    expect(reply).toContain('understood 3 concepts');
    expect(reply).toContain('/gaps --all');
  });

  it('renders header with counts', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'KV Cache', sourceType: 'paper', detectionMethod: 'auto' });
    const result = {
      gaps: [gap],
      totalAll: 1,
      totalActive: 1,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('🧠 Knowledge gaps');
    expect(reply).toContain('1 active');
  });

  it('renders gap concept and status label', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Speculative Decoding', sourceType: 'paper', detectionMethod: 'auto' });
    const result = {
      gaps: [gap],
      totalAll: 1,
      totalActive: 1,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('Speculative Decoding');
    expect(reply).toContain('🔍 new');
  });

  it('renders arxiv ID and paper title when available', () => {
    const db = makeDb() as any;
    // Insert a paper first
    insertPaper(db, '2401.12345', 'Fast Inference Paper');
    const gap = createGap(db, {
      concept: 'Speculative Decoding',
      sourceType: 'paper',
      arxivId: '2401.12345',
      detectionMethod: 'auto',
    });
    const result = {
      gaps: [gap],
      totalAll: 1,
      totalActive: 1,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('2401.12345');
    expect(reply).toContain('Fast Inference Paper');
  });

  it('shows priority stars correctly', () => {
    const db = makeDb() as any;
    const highPriGap = createGap(db, {
      concept: 'High Priority',
      sourceType: 'paper',
      detectionMethod: 'auto',
      priority: 80,
    });
    const result = {
      gaps: [highPriGap],
      totalAll: 1,
      totalActive: 1,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('★★★');
  });

  it('shows footer hint to use --all when understood gaps exist', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Active', sourceType: 'paper', detectionMethod: 'auto' });
    const result = {
      gaps: [gap],
      totalAll: 2,
      totalActive: 1,
      totalUnderstood: 1,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('/gaps --all');
  });

  it('does not show --all footer when showingAll=true', () => {
    const db = makeDb() as any;
    const gap = createGap(db, { concept: 'Active', sourceType: 'paper', detectionMethod: 'auto' });
    const result = {
      gaps: [gap],
      totalAll: 2,
      totalActive: 1,
      totalUnderstood: 1,
    };
    const reply = renderGapsReply(result, true);
    expect(reply).not.toContain('/gaps --all');
  });

  it('truncates long paper titles', () => {
    const db = makeDb() as any;
    const longTitle = 'A'.repeat(60);
    insertPaper(db, '2401.99999', longTitle);
    const gap = createGap(db, {
      concept: 'Test Concept',
      sourceType: 'paper',
      arxivId: '2401.99999',
      detectionMethod: 'auto',
    });
    const result = {
      gaps: [gap],
      totalAll: 1,
      totalActive: 1,
      totalUnderstood: 0,
    };
    const reply = renderGapsReply(result);
    expect(reply).toContain('…');
    // Title in reply should be ≤53 chars (50 + '…' = 51 + quotes)
    const titleMatch = reply.match(/"([^"]+)"/);
    expect(titleMatch).not.toBeNull();
    if (titleMatch?.[1]) { expect(titleMatch[1].length).toBeLessThanOrEqual(50); }
  });
});

// ─── Parser integration ───────────────────────────────────────────────────────

import { parseFeedbackMessage } from '../feedback/parser.js';

describe('parseFeedbackMessage /gaps integration', () => {

  it('parses /gaps as a query command', () => {
    const result = parseFeedbackMessage('/gaps');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('query');
    if (result.kind !== 'query') return;
    expect(result.query.command).toBe('gaps');
    expect(result.query.includeUnderstood).toBe(false);
    expect(result.query.gapsStatusFilter).toBeNull();
  });

  it('parses /gaps --all', () => {
    const result = parseFeedbackMessage('/gaps --all');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.kind !== 'query') return;
    expect(result.query.includeUnderstood).toBe(true);
  });

  it('parses /gaps --limit 15', () => {
    const result = parseFeedbackMessage('/gaps --limit 15');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.kind !== 'query') return;
    expect(result.query.limit).toBe(15);
  });

  it('parses /gaps --status understood', () => {
    const result = parseFeedbackMessage('/gaps --status understood');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.kind !== 'query') return;
    expect(result.query.gapsStatusFilter).toBe('understood');
  });

  it('parses /gaps --status identified', () => {
    const result = parseFeedbackMessage('/gaps --status identified');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.kind !== 'query') return;
    expect(result.query.gapsStatusFilter).toBe('identified');
  });
});
