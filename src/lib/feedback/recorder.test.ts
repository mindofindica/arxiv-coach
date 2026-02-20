/**
 * Tests for feedback recorder.
 * Uses an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, migrate } from '../db.js';
import { ensureFeedbackTables } from './migrate.js';
import { recordFeedback, formatConfirmation, SIGNAL_STRENGTHS } from './recorder.js';
import type { Db } from '../db.js';
import type { FeedbackType } from './parser.js';

function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Db = { sqlite };
  migrate(db);
  ensureFeedbackTables(db);
  return db;
}

function seedPaper(db: Db, arxivId: string, title = 'Test Paper') {
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO papers
         (arxiv_id, latest_version, title, abstract, authors_json, categories_json,
          published_at, updated_at, pdf_path, txt_path, meta_path, ingested_at)
       VALUES (?, 'v1', ?, 'Abstract.', '[]', '[]', datetime('now'), datetime('now'),
               '/tmp/x.pdf', '/tmp/x.txt', '/tmp/x.json', datetime('now'))`,
    )
    .run(arxivId, title);
}

// ── Signal strength constants ──────────────────────────────────────────────

describe('SIGNAL_STRENGTHS', () => {
  it('love > read > save > 0 > meh > skip', () => {
    expect(SIGNAL_STRENGTHS.love).toBeGreaterThan(SIGNAL_STRENGTHS.read);
    expect(SIGNAL_STRENGTHS.read).toBeGreaterThan(SIGNAL_STRENGTHS.save);
    expect(SIGNAL_STRENGTHS.save).toBeGreaterThan(0);
    expect(SIGNAL_STRENGTHS.meh).toBeLessThan(0);
    expect(SIGNAL_STRENGTHS.skip).toBeLessThan(SIGNAL_STRENGTHS.meh);
  });
});

// ── recordFeedback ─────────────────────────────────────────────────────────

describe('recordFeedback', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns paper_not_found when paper is absent', () => {
    const result = recordFeedback({ db, arxivId: '9999.99999', feedbackType: 'read' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('paper_not_found');
  });

  it('records feedback successfully', () => {
    seedPaper(db, '2403.12345', 'Attention Is All You Need');
    const result = recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyRecorded).toBe(false);
      expect(result.paper.title).toBe('Attention Is All You Need');
      expect(result.paper.arxivId).toBe('2403.12345');
    }
  });

  it('records an interaction row', () => {
    seedPaper(db, '2403.12345');
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'love' });
    const row = db.sqlite
      .prepare('SELECT * FROM user_interactions WHERE paper_id = ? AND command = ?')
      .get('2403.12345', 'love') as { signal_strength: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.signal_strength).toBe(SIGNAL_STRENGTHS.love);
  });

  it('is idempotent — returns alreadyRecorded=true on second call', () => {
    seedPaper(db, '2403.12345');
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });
    const second = recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyRecorded).toBe(true);
  });

  it('allows different feedback types for same paper', () => {
    seedPaper(db, '2403.12345');
    const r1 = recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });
    const r2 = recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'save' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.alreadyRecorded).toBe(false);
  });

  it('adds to reading_list on /save', () => {
    seedPaper(db, '2403.12345');
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'save', priority: 7 });

    const row = db.sqlite
      .prepare('SELECT * FROM reading_list WHERE paper_id = ?')
      .get('2403.12345') as { status: string; priority: number } | undefined;

    expect(row).toBeDefined();
    expect(row?.status).toBe('unread');
    expect(row?.priority).toBe(7);
  });

  it('uses default priority 5 for /save when not specified', () => {
    seedPaper(db, '2403.12345');
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'save' });

    const row = db.sqlite
      .prepare('SELECT priority FROM reading_list WHERE paper_id = ?')
      .get('2403.12345') as { priority: number } | undefined;

    expect(row?.priority).toBe(5);
  });

  it('marks reading_list status as read (with read_at) on /read', () => {
    seedPaper(db, '2403.12345');
    // Save first (adds to reading list as 'unread')
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'save' });
    // Then mark as read
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });

    const row = db.sqlite
      .prepare('SELECT status, read_at FROM reading_list WHERE paper_id = ?')
      .get('2403.12345') as { status: string; read_at: string | null } | undefined;

    expect(row?.status).toBe('read');
    expect(row?.read_at).toBeTruthy();
  });

  it('/read marks in_progress reading_list items as read too', () => {
    seedPaper(db, '2403.12345');
    // Manually insert in_progress entry
    db.sqlite
      .prepare(`INSERT INTO reading_list (id, paper_id, status) VALUES ('rl-1', '2403.12345', 'in_progress')`)
      .run();
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read' });

    const row = db.sqlite
      .prepare('SELECT status FROM reading_list WHERE paper_id = ?')
      .get('2403.12345') as { status: string } | undefined;

    expect(row?.status).toBe('read');
  });

  it('stores notes in metadata', () => {
    seedPaper(db, '2403.12345');
    recordFeedback({ db, arxivId: '2403.12345', feedbackType: 'read', notes: 'Very relevant' });

    const row = db.sqlite
      .prepare('SELECT metadata FROM user_interactions WHERE paper_id = ?')
      .get('2403.12345') as { metadata: string } | undefined;

    expect(row).toBeDefined();
    const meta = JSON.parse(row!.metadata);
    expect(meta.notes).toBe('Very relevant');
    expect(meta.source).toBe('signal');
  });

  // ── All feedback types ────────────────────────────────────────────────

  const allTypes: FeedbackType[] = ['read', 'skip', 'save', 'love', 'meh'];
  for (const type of allTypes) {
    it(`records feedback type: ${type}`, () => {
      seedPaper(db, '2403.12345');
      const result = recordFeedback({ db, arxivId: '2403.12345', feedbackType: type });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.alreadyRecorded).toBe(false);
    });
  }
});

// ── formatConfirmation ─────────────────────────────────────────────────────

describe('formatConfirmation', () => {
  it('includes icon and title for new feedback', () => {
    const msg = formatConfirmation(
      { ok: true, paper: { arxivId: '2403.12345', title: 'Test Paper' }, alreadyRecorded: false },
      'read',
    );
    expect(msg).toContain('✅');
    expect(msg).toContain('Test Paper');
    expect(msg).not.toContain('Already');
  });

  it('says "Already recorded" for duplicate', () => {
    const msg = formatConfirmation(
      { ok: true, paper: { arxivId: '2403.12345', title: 'Test Paper' }, alreadyRecorded: true },
      'skip',
    );
    expect(msg).toContain('Already');
    expect(msg).toContain('skip');
  });

  it('mentions reading list for /save', () => {
    const msg = formatConfirmation(
      { ok: true, paper: { arxivId: '2403.12345', title: 'My Paper' }, alreadyRecorded: false },
      'save',
    );
    expect(msg).toContain('reading list');
  });

  it('includes boost encouragement for /love', () => {
    const msg = formatConfirmation(
      { ok: true, paper: { arxivId: '2403.12345', title: 'Great Paper' }, alreadyRecorded: false },
      'love',
    );
    expect(msg).toContain('❤️');
    expect(msg).toMatch(/similar|more like/i);
  });
});
