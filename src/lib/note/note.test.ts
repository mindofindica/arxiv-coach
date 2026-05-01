/**
 * Tests for /note command — addNote() and formatNoteReply()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { addNote, formatNoteReply } from './note.js';
import type { Db } from '../db.js';
import BetterSqlite3 from 'better-sqlite3';

// ── Minimal in-memory DB setup ─────────────────────────────────────────────

function makeDb(): Db {
  const sqlite = new BetterSqlite3(':memory:');

  // Minimal schema — only what addNote needs
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      arxiv_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_feedback (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_interactions (
      id TEXT PRIMARY KEY,
      interaction_type TEXT NOT NULL,
      paper_id TEXT,
      command TEXT,
      signal_strength INTEGER,
      metadata TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );
  `);

  return { sqlite } as Db;
}

function seedPaper(db: Db, arxivId = '2403.12345', title = 'Test Paper Title') {
  db.sqlite.prepare('INSERT INTO papers (arxiv_id, title) VALUES (?, ?)').run(arxivId, title);
}

function seedFeedback(db: Db, arxivId = '2403.12345', feedbackType = 'read', reason: string | null = null) {
  db.sqlite
    .prepare('INSERT INTO paper_feedback (id, paper_id, feedback_type, reason) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), arxivId, feedbackType, reason);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('addNote()', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  // ── Paper not found ────────────────────────────────────────────────────

  it('returns paper_not_found when arxiv ID is unknown', () => {
    const result = addNote({ db, arxivId: '9999.99999', noteText: 'some note' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('paper_not_found');
    }
  });

  // ── No prior feedback ──────────────────────────────────────────────────

  it('records a standalone note interaction when no feedback exists', () => {
    seedPaper(db);
    const result = addNote({ db, arxivId: '2403.12345', noteText: 'interesting approach' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hadFeedback).toBe(false);
      expect(result.updatedNote).toBe('interesting approach');
      expect(result.previousNote).toBeNull();
    }

    // Should have written to user_interactions
    const rows = db.sqlite.prepare("SELECT * FROM user_interactions WHERE paper_id = '2403.12345'").all() as Array<{ interaction_type: string; metadata: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.interaction_type).toBe('note_added');
    const meta = JSON.parse(rows[0]!.metadata);
    expect(meta.note).toBe('interesting approach');
  });

  it('returns the paper title in the result', () => {
    seedPaper(db, '2403.12345', 'Attention Is All You Need');
    const result = addNote({ db, arxivId: '2403.12345', noteText: 'classic' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paper.title).toBe('Attention Is All You Need');
    }
  });

  // ── With prior feedback, no existing note ─────────────────────────────

  it('sets note when feedback exists but reason is null', () => {
    seedPaper(db);
    seedFeedback(db, '2403.12345', 'read', null);

    const result = addNote({ db, arxivId: '2403.12345', noteText: 'this was very insightful' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hadFeedback).toBe(true);
      expect(result.previousNote).toBeNull();
      expect(result.updatedNote).toBe('this was very insightful');
    }

    const row = db.sqlite
      .prepare('SELECT reason FROM paper_feedback WHERE paper_id = ?')
      .get('2403.12345') as { reason: string };
    expect(row.reason).toBe('this was very insightful');
  });

  it('sets note when feedback exists but reason is empty string', () => {
    seedPaper(db);
    seedFeedback(db, '2403.12345', 'love', '');

    const result = addNote({ db, arxivId: '2403.12345', noteText: 'great paper' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Empty string is treated as "no note" (falsy)
      expect(result.updatedNote).toBe('great paper');
    }
  });

  // ── With prior feedback and existing note ─────────────────────────────

  it('appends to existing note with pipe separator', () => {
    seedPaper(db);
    seedFeedback(db, '2403.12345', 'save', 'original note');

    const result = addNote({ db, arxivId: '2403.12345', noteText: 'extra thought' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previousNote).toBe('original note');
      expect(result.updatedNote).toBe('original note | extra thought');
    }

    const row = db.sqlite
      .prepare('SELECT reason FROM paper_feedback WHERE paper_id = ?')
      .get('2403.12345') as { reason: string };
    expect(row.reason).toBe('original note | extra thought');
  });

  it('uses the most recent feedback row when multiple exist', () => {
    seedPaper(db);
    // Insert in order — second one is most recent
    db.sqlite.prepare("INSERT INTO paper_feedback (id, paper_id, feedback_type, reason, created_at) VALUES (?, ?, ?, ?, datetime('now', '-1 hour'))").run(crypto.randomUUID(), '2403.12345', 'save', 'older note');
    db.sqlite.prepare("INSERT INTO paper_feedback (id, paper_id, feedback_type, reason, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(crypto.randomUUID(), '2403.12345', 'read', 'recent note');

    const result = addNote({ db, arxivId: '2403.12345', noteText: 'new thought' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.previousNote).toBe('recent note');
      expect(result.updatedNote).toBe('recent note | new thought');
    }

    // Only the most recent (read) row should be updated
    const readRow = db.sqlite
      .prepare("SELECT reason FROM paper_feedback WHERE paper_id = ? AND feedback_type = 'read'")
      .get('2403.12345') as { reason: string };
    expect(readRow.reason).toBe('recent note | new thought');

    const saveRow = db.sqlite
      .prepare("SELECT reason FROM paper_feedback WHERE paper_id = ? AND feedback_type = 'save'")
      .get('2403.12345') as { reason: string };
    expect(saveRow.reason).toBe('older note');
  });

  it('does not create a user_interaction when feedback exists', () => {
    seedPaper(db);
    seedFeedback(db, '2403.12345', 'read', null);

    addNote({ db, arxivId: '2403.12345', noteText: 'noted' });

    const rows = db.sqlite.prepare("SELECT * FROM user_interactions WHERE paper_id = '2403.12345'").all();
    expect(rows.length).toBe(0);
  });

  // ── Note content ──────────────────────────────────────────────────────

  it('preserves multi-word note text', () => {
    seedPaper(db);
    seedFeedback(db);
    const longNote = 'This paper introduces a novel attention mechanism that could be applied to our multi-agent orchestration work';
    const result = addNote({ db, arxivId: '2403.12345', noteText: longNote });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updatedNote).toBe(longNote);
    }
  });

  it('handles note text with special characters', () => {
    seedPaper(db);
    seedFeedback(db);
    const note = "connects to O'Brien et al. (2024) — see ~/papers/ref.pdf";
    const result = addNote({ db, arxivId: '2403.12345', noteText: note });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updatedNote).toBe(note);
    }
  });
});

// ── formatNoteReply() ──────────────────────────────────────────────────────

describe('formatNoteReply()', () => {
  const paper = { arxivId: '2403.12345', title: 'A Paper About Things' };

  it('returns a confirmation for a feedback-backed note', () => {
    const msg = formatNoteReply({
      ok: true,
      paper,
      previousNote: null,
      updatedNote: 'fascinating approach',
      hadFeedback: true,
    });

    expect(msg).toContain('Note saved');
    expect(msg).toContain('attached to your feedback');
    expect(msg).toContain('fascinating approach');
    expect(msg).toContain('A Paper About Things');
  });

  it('mentions standalone note when no prior feedback', () => {
    const msg = formatNoteReply({
      ok: true,
      paper,
      previousNote: null,
      updatedNote: 'standalone thought',
      hadFeedback: false,
    });

    expect(msg).toContain('standalone note');
    expect(msg).toContain('standalone thought');
  });

  it('truncates long titles to 60 chars', () => {
    const longTitle = 'A Very Long Paper Title That Goes On And On And Definitely Exceeds Sixty Characters';
    const msg = formatNoteReply({
      ok: true,
      paper: { arxivId: '2403.12345', title: longTitle },
      previousNote: null,
      updatedNote: 'note',
      hadFeedback: true,
    });

    expect(msg).toContain('…');
    // The title portion should be max 63 chars (60 + '…')
    const titleLine = msg.split('\n').find(l => l.startsWith('"'));
    expect(titleLine).toBeDefined();
    expect(titleLine!.length).toBeLessThanOrEqual(65); // with quotes
  });

  it('truncates long note text to 120 chars', () => {
    const longNote = 'A'.repeat(200);
    const msg = formatNoteReply({
      ok: true,
      paper,
      previousNote: null,
      updatedNote: longNote,
      hadFeedback: true,
    });

    expect(msg).toContain('…');
    const noteLine = msg.split('\n').find(l => l.startsWith('💬'));
    expect(noteLine).toBeDefined();
    expect(noteLine!.length).toBeLessThanOrEqual(128); // '💬 ' prefix + 120 + '…' padding
  });

  it('does not truncate short titles or notes', () => {
    const msg = formatNoteReply({
      ok: true,
      paper,
      previousNote: null,
      updatedNote: 'short note',
      hadFeedback: true,
    });

    expect(msg).not.toContain('…');
    expect(msg).toContain('A Paper About Things');
    expect(msg).toContain('short note');
  });
});
