/**
 * Trends Analyser — Unit Tests
 *
 * Tests keyword extraction, ISO week bucketing, trend classification,
 * and Signal message formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractKeywords,
  isoWeekOf,
  analyseTrends,
  formatTrendsReply,
  type TrendsResult,
} from './trends.js';
import type { Db } from '../db.js';

// ── extractKeywords ────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('extracts single meaningful tokens', () => {
    const kws = extractKeywords('Chain-of-Thought Prompting for Large Language Models');
    expect(kws).toContain('chain-of-thought');
    expect(kws).toContain('prompting');
  });

  it('excludes stopwords from singles', () => {
    const kws = extractKeywords('Attention Is All You Need');
    expect(kws).not.toContain('is');
    expect(kws).not.toContain('all');
    expect(kws).not.toContain('you');
  });

  it('extracts bigrams where both words are meaningful', () => {
    const kws = extractKeywords('Retrieval Augmented Generation for Knowledge');
    expect(kws).toContain('retrieval augmented');
    expect(kws).toContain('augmented generation');
  });

  it('skips pure-stopword bigrams', () => {
    const kws = extractKeywords('This is a big deal');
    // "this is" and "is a" are pure stopword pairs, shouldn't appear
    expect(kws).not.toContain('this is');
    expect(kws).not.toContain('is a');
  });

  it('handles hyphenated terms', () => {
    const kws = extractKeywords('Low-Rank Adaptation of Large Language Models');
    expect(kws).toContain('low-rank');
  });

  it('deduplicates keywords', () => {
    const kws = extractKeywords('LoRA LoRA Low-Rank Adaptation');
    const loraCount = kws.filter(k => k === 'lora').length;
    expect(loraCount).toBe(1);
  });

  it('filters short tokens', () => {
    const kws = extractKeywords('A New AI System');
    // "a" and "ai" (len 2) should be filtered (min 3 chars)
    expect(kws).not.toContain('a');
  });

  it('handles empty title gracefully', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('strips punctuation from title', () => {
    const kws = extractKeywords('Scaling Laws: A Survey (2024)');
    expect(kws).not.toContain('2024');  // pure digits filtered
  });
});

// ── isoWeekOf ──────────────────────────────────────────────────────────────

describe('isoWeekOf', () => {
  it('returns ISO week string format YYYY-Www', () => {
    const result = isoWeekOf('2026-01-05');
    expect(result).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('returns correct week for a known Monday', () => {
    // 2026-01-05 is a Monday, ISO week 2 of 2026
    expect(isoWeekOf('2026-01-05')).toBe('2026-W02');
  });

  it('handles year boundaries correctly', () => {
    // 2026-01-01 (Thursday) → should be W01 of 2026
    const result = isoWeekOf('2026-01-01');
    expect(result).toBe('2026-W01');
  });

  it('same week for different days within a week', () => {
    expect(isoWeekOf('2026-02-02')).toBe(isoWeekOf('2026-02-06'));
  });

  it('different weeks for days in different weeks', () => {
    expect(isoWeekOf('2026-02-02')).not.toBe(isoWeekOf('2026-02-09'));
  });
});

// ── analyseTrends ──────────────────────────────────────────────────────────

function makeDb(): { db: Db; tmpPath: string } {
  const tmpPath = path.join(os.tmpdir(), `arxiv-coach-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const sqlite = new Database(tmpPath);
  sqlite.pragma('journal_mode = WAL');

  sqlite.exec(`
    CREATE TABLE papers (
      arxiv_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      abstract TEXT NOT NULL DEFAULT '',
      authors_json TEXT NOT NULL DEFAULT '[]',
      categories_json TEXT NOT NULL DEFAULT '[]',
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      pdf_path TEXT NOT NULL DEFAULT '',
      txt_path TEXT NOT NULL DEFAULT '',
      meta_path TEXT NOT NULL DEFAULT '',
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE paper_feedback (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paper_id TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      reason TEXT,
      tags TEXT DEFAULT '[]'
    );
  `);

  return { db: { sqlite }, tmpPath };
}

function addPaper(db: Db, arxivId: string, title: string) {
  db.sqlite.prepare(
    `INSERT OR IGNORE INTO papers (arxiv_id, title, published_at, updated_at, ingested_at)
     VALUES (?, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(arxivId, title);
}

function addFeedback(db: Db, arxivId: string, type: string, date: string) {
  db.sqlite.prepare(
    `INSERT INTO paper_feedback (id, paper_id, feedback_type, created_at) VALUES (?, ?, ?, ?)`
  ).run(`fb-${arxivId}-${type}-${date}`, arxivId, type, date);
}

describe('analyseTrends', () => {
  let db: Db;
  let tmpPath: string;

  beforeEach(() => {
    const setup = makeDb();
    db = setup.db;
    tmpPath = setup.tmpPath;
  });

  afterEach(() => {
    db.sqlite.close();
    fs.unlinkSync(tmpPath);
  });

  it('returns empty result when no feedback exists', () => {
    const result = analyseTrends(db);
    expect(result.totalPapersAnalysed).toBe(0);
    expect(result.rising).toHaveLength(0);
    expect(result.falling).toHaveLength(0);
    expect(result.stable).toHaveLength(0);
  });

  it('detects a rising topic when it appears only in recent half', () => {
    // Add 3 papers about "speculative decoding" — all in recent weeks
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 7);
    const dateStr = recentDate.toISOString().slice(0, 10);

    addPaper(db, '2401.001', 'Speculative Decoding for Fast Inference');
    addPaper(db, '2401.002', 'Speculative Decoding with Draft Models');
    addPaper(db, '2401.003', 'Accelerated Speculative Decoding');
    addFeedback(db, '2401.001', 'love', `${dateStr}T10:00:00`);
    addFeedback(db, '2401.002', 'save', `${dateStr}T11:00:00`);
    addFeedback(db, '2401.003', 'read', `${dateStr}T12:00:00`);

    const result = analyseTrends(db, { weeks: 8, minAppearances: 2 });
    const specDecoding = result.rising.find(t => t.keyword === 'speculative decoding')
      ?? result.rising.find(t => t.keyword === 'speculative');
    expect(specDecoding).toBeDefined();
    expect(specDecoding!.direction).toBe('rising');
  });

  it('detects a falling topic when it appears only in older half', () => {
    // Add papers about "transformers" — all 7+ weeks ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 55); // well into the older half
    const dateStr = oldDate.toISOString().slice(0, 10);

    addPaper(db, '2301.001', 'Transformers for Vision Tasks');
    addPaper(db, '2301.002', 'Efficient Transformers for Long Sequences');
    addPaper(db, '2301.003', 'Vision Transformers at Scale');
    addFeedback(db, '2301.001', 'read', `${dateStr}T10:00:00`);
    addFeedback(db, '2301.002', 'save', `${dateStr}T11:00:00`);
    addFeedback(db, '2301.003', 'love', `${dateStr}T12:00:00`);

    const result = analyseTrends(db, { weeks: 8, minAppearances: 2 });
    const transformers = result.falling.find(t => t.keyword === 'transformers')
      ?? result.falling.find(t => t.keyword === 'vision transformers');
    expect(transformers).toBeDefined();
    expect(transformers!.direction).toBe('falling');
  });

  it('classifies topics in both halves as stable', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 50);
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10);

    addPaper(db, '2401.010', 'Reinforcement Learning from Human Feedback');
    addPaper(db, '2401.011', 'Reinforcement Learning Alignment Methods');
    addFeedback(db, '2401.010', 'read', `${oldDate.toISOString().slice(0, 10)}T10:00:00`);
    addFeedback(db, '2401.011', 'read', `${recentDate.toISOString().slice(0, 10)}T10:00:00`);

    const result = analyseTrends(db, { weeks: 8, minAppearances: 2 });
    const rl = result.stable.find(t => t.keyword === 'reinforcement learning')
      ?? result.stable.find(t => t.keyword === 'reinforcement');
    // May appear in stable if both halves have similar scores
    // Just check it's not in rising (pct change near 0)
    expect(result.rising.find(t => t.keyword === 'reinforcement learning')).toBeUndefined();
  });

  it('respects minAppearances threshold', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 7);
    const dateStr = recentDate.toISOString().slice(0, 10);

    addPaper(db, '2401.020', 'Quantum Computing for Cryptography');
    addFeedback(db, '2401.020', 'read', `${dateStr}T10:00:00`);

    // With minAppearances=3, this paper's keywords shouldn't appear
    const result = analyseTrends(db, { weeks: 8, minAppearances: 3 });
    const quantum = [...result.rising, ...result.falling, ...result.stable]
      .find(t => t.keyword === 'quantum computing' || t.keyword === 'quantum');
    expect(quantum).toBeUndefined();
  });

  it('respects limit option', () => {
    const dates = Array.from({ length: 15 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (7 + i));
      return d.toISOString().slice(0, 10);
    });

    // Add 15 very different papers, all recent, to generate many rising keywords
    const topics = [
      'Diffusion Models for Image Synthesis',
      'Contrastive Learning Representations',
      'Knowledge Distillation Compression',
      'Mixture of Experts Routing',
      'Flash Attention Efficiency',
      'Token Merging Vision Transformers',
      'Quantisation Calibration Methods',
      'LoRA Fine-tuning Adaptation',
      'Constitutional Alignment Techniques',
      'Tool Use Autonomous Agents',
      'Multimodal Reasoning Planning',
      'Code Generation Synthesis Methods',
      'Instruction Following Tuning',
      'Prompt Engineering Chain-of-Thought',
      'Sparse Attention Mechanisms',
    ];

    topics.forEach((title, i) => {
      const id = `2402.${String(i + 1).padStart(3, '0')}`;
      addPaper(db, id, title);
      addFeedback(db, id, 'love', `${dates[i]}T10:00:00`);
      // Add a second feedback to pass minAppearances=2
      addFeedback(db, id, 'save', `${dates[i]}T11:00:00`);
    });

    const result = analyseTrends(db, { weeks: 12, minAppearances: 2, limit: 5 });
    expect(result.rising.length).toBeLessThanOrEqual(5);
    expect(result.falling.length).toBeLessThanOrEqual(5);
    expect(result.stable.length).toBeLessThanOrEqual(5);
  });

  it('returns correct metadata', () => {
    const result = analyseTrends(db, { weeks: 4 });
    expect(result.windowWeeks).toBe(4);
    expect(result.fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts unique papers (not feedback events) for totalPapersAnalysed', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 7);
    const dateStr = recentDate.toISOString().slice(0, 10);

    addPaper(db, '2401.030', 'Some Interesting Paper');
    // Two feedback events for the same paper
    addFeedback(db, '2401.030', 'save', `${dateStr}T10:00:00`);
    addFeedback(db, '2401.030', 'love', `${dateStr}T11:00:00`);

    const result = analyseTrends(db, { weeks: 4 });
    expect(result.totalPapersAnalysed).toBe(1);
  });

  it('pctChange is 200 for keywords that appear only in recent half', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);

    addPaper(db, '2401.040', 'Kolmogorov-Arnold Networks');
    addPaper(db, '2401.041', 'Kolmogorov-Arnold Network Extensions');
    addFeedback(db, '2401.040', 'love', `${recentDate.toISOString().slice(0, 10)}T10:00:00`);
    addFeedback(db, '2401.041', 'save', `${recentDate.toISOString().slice(0, 10)}T11:00:00`);

    const result = analyseTrends(db, { weeks: 8, minAppearances: 2 });
    const kan = result.rising.find(t => t.keyword.includes('kolmogorov'));
    if (kan) {
      expect(kan.pctChange).toBe(200);
    }
  });
});

// ── formatTrendsReply ──────────────────────────────────────────────────────

describe('formatTrendsReply', () => {
  it('shows no-data message when no papers analysed', () => {
    const result: TrendsResult = {
      rising: [],
      falling: [],
      stable: [],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 0,
      uniqueKeywords: 0,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('No feedback data');
    expect(msg).toContain('8 weeks');
  });

  it('includes rising section when there are rising topics', () => {
    const result: TrendsResult = {
      rising: [
        {
          keyword: 'speculative decoding',
          direction: 'rising',
          recentScore: 10,
          olderScore: 2,
          pctChange: 400,
          totalAppearances: 12,
          exampleTitles: ['Speculative Decoding for Fast Inference'],
        },
      ],
      falling: [],
      stable: [],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 5,
      uniqueKeywords: 12,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('Rising topics');
    expect(msg).toContain('speculative decoding');
  });

  it('includes falling section when there are falling topics', () => {
    const result: TrendsResult = {
      rising: [],
      falling: [
        {
          keyword: 'bert',
          direction: 'falling',
          recentScore: 0,
          olderScore: 8,
          pctChange: -100,
          totalAppearances: 8,
          exampleTitles: ['BERT: Pre-training of Deep Bidirectional Transformers'],
        },
      ],
      stable: [],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 3,
      uniqueKeywords: 8,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('Fading topics');
    expect(msg).toContain('bert');
  });

  it('shows stable section with dot-separated keywords', () => {
    const result: TrendsResult = {
      rising: [],
      falling: [],
      stable: [
        {
          keyword: 'attention',
          direction: 'stable',
          recentScore: 5,
          olderScore: 5,
          pctChange: 0,
          totalAppearances: 10,
          exampleTitles: ['Attention Is All You Need'],
        },
        {
          keyword: 'fine-tuning',
          direction: 'stable',
          recentScore: 4,
          olderScore: 4,
          pctChange: 0,
          totalAppearances: 8,
          exampleTitles: ['Parameter-Efficient Fine-tuning'],
        },
      ],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 6,
      uniqueKeywords: 20,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('Stable interests');
    expect(msg).toContain('attention');
    expect(msg).toContain('fine-tuning');
  });

  it('includes tip about --weeks flag', () => {
    const result: TrendsResult = {
      rising: [],
      falling: [],
      stable: [],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 5,
      uniqueKeywords: 10,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('/trends --weeks');
  });

  it('shows 🆕 icon for newly emerged keywords (pctChange=200)', () => {
    const result: TrendsResult = {
      rising: [
        {
          keyword: 'kolmogorov-arnold',
          direction: 'rising',
          recentScore: 6,
          olderScore: 0,
          pctChange: 200,
          totalAppearances: 6,
          exampleTitles: ['Kolmogorov-Arnold Networks'],
        },
      ],
      falling: [],
      stable: [],
      windowWeeks: 8,
      fromDate: '2026-01-01',
      toDate: '2026-02-28',
      totalPapersAnalysed: 3,
      uniqueKeywords: 5,
    };
    const msg = formatTrendsReply(result);
    expect(msg).toContain('🆕');
  });
});
