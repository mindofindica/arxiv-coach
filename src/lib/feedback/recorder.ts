/**
 * Feedback Recorder
 *
 * Persists user feedback to SQLite.
 * Uses arxiv_id as the primary key (papers.arxiv_id), not a UUID.
 *
 * Tables (created by migration v6 in db.ts):
 *   - user_interactions
 *   - paper_feedback
 *   - reading_list
 */

import crypto from 'node:crypto';
import type { Db } from '../db.js';
import type { FeedbackType } from './parser.js';

export const SIGNAL_STRENGTHS: Record<FeedbackType, number> = {
  love: 10,
  read: 8,
  save: 5,
  meh: -2,
  skip: -5,
};

export const FEEDBACK_ICONS: Record<FeedbackType, string> = {
  love: '❤️',
  read: '✅',
  save: '⭐',
  skip: '⏭️',
  meh: '😐',
};

function uuid(): string {
  return crypto.randomUUID();
}

export interface RecordOptions {
  db: Db;
  arxivId: string;
  feedbackType: FeedbackType;
  notes?: string | null;
  reason?: string | null;
  priority?: number | null;   // for /save, 1-10
}

export interface PaperInfo {
  arxivId: string;
  title: string;
}

export type RecordResult =
  | { ok: true; paper: PaperInfo; alreadyRecorded: boolean }
  | { ok: false; error: 'paper_not_found' | 'db_error'; message: string };

/**
 * Look up a paper by arxiv ID.
 */
function findPaper(db: Db, arxivId: string): PaperInfo | null {
  const row = db.sqlite
    .prepare('SELECT arxiv_id, title FROM papers WHERE arxiv_id = ?')
    .get(arxivId) as { arxiv_id: string; title: string } | undefined;

  if (!row) return null;
  return { arxivId: row.arxiv_id, title: row.title };
}

/**
 * Check if this feedback type has already been recorded for the paper.
 */
function hasExistingFeedback(db: Db, arxivId: string, feedbackType: FeedbackType): boolean {
  const existing = db.sqlite
    .prepare('SELECT id FROM paper_feedback WHERE paper_id = ? AND feedback_type = ?')
    .get(arxivId, feedbackType) as { id: string } | undefined;
  return Boolean(existing);
}

/**
 * Record user feedback for a paper.
 * Idempotent: calling twice with same (arxivId, feedbackType) is safe — returns alreadyRecorded=true.
 */
export function recordFeedback(opts: RecordOptions): RecordResult {
  const { db, arxivId, feedbackType, notes = null, reason = null, priority = null } = opts;

  const paper = findPaper(db, arxivId);
  if (!paper) {
    return {
      ok: false,
      error: 'paper_not_found',
      message: `Paper not found in database: ${arxivId}`,
    };
  }

  const signalStrength = SIGNAL_STRENGTHS[feedbackType];

  // Idempotency check
  if (hasExistingFeedback(db, arxivId, feedbackType)) {
    return { ok: true, paper, alreadyRecorded: true };
  }

  try {
    // Insert feedback
    db.sqlite
      .prepare(
        `INSERT INTO paper_feedback (id, paper_id, feedback_type, reason)
         VALUES (?, ?, ?, ?)`,
      )
      .run(uuid(), arxivId, feedbackType, reason ?? notes);

    // Log interaction
    db.sqlite
      .prepare(
        `INSERT INTO user_interactions
           (id, interaction_type, paper_id, command, signal_strength, metadata)
         VALUES (?, 'feedback_given', ?, ?, ?, ?)`,
      )
      .run(
        uuid(),
        arxivId,
        feedbackType,
        signalStrength,
        JSON.stringify({ source: 'signal', notes, reason }),
      );

    // If /save, add to reading list
    if (feedbackType === 'save') {
      const effectivePriority = priority ?? 5;
      const existingEntry = db.sqlite
        .prepare('SELECT id FROM reading_list WHERE paper_id = ?')
        .get(arxivId) as { id: string } | undefined;

      if (!existingEntry) {
        db.sqlite
          .prepare(
            `INSERT INTO reading_list (id, paper_id, priority, notes)
             VALUES (?, ?, ?, ?)`,
          )
          .run(uuid(), arxivId, effectivePriority, notes);
      }
    }

    // If /read and paper is in reading list as unread, mark in_progress
    if (feedbackType === 'read') {
      db.sqlite
        .prepare(
          `UPDATE reading_list SET status = 'in_progress'
           WHERE paper_id = ? AND status = 'unread'`,
        )
        .run(arxivId);
    }

    return { ok: true, paper, alreadyRecorded: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'db_error', message: msg };
  }
}

/**
 * Format a human-readable confirmation message for Signal.
 */
export function formatConfirmation(
  result: Extract<RecordResult, { ok: true }>,
  feedbackType: FeedbackType,
): string {
  const icon = FEEDBACK_ICONS[feedbackType];
  const { paper, alreadyRecorded } = result;

  if (alreadyRecorded) {
    return `${icon} Already recorded as ${feedbackType}: "${paper.title}"`;
  }

  const encouragement: Record<FeedbackType, string> = {
    love: 'Boosting similar papers.',
      read: "Great — I'll prioritise more like this.",
    save: 'Added to reading list.',
    skip: 'Got it — deprioritising similar papers.',
    meh: 'Noted — adjusting future recommendations.',
  };

  return `${icon} ${feedbackType.charAt(0).toUpperCase() + feedbackType.slice(1)}: "${paper.title}"\n${encouragement[feedbackType]}`;
}
