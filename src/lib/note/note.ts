/**
 * /note command — append or update a note on an existing paper feedback.
 *
 * Design:
 *   /note <arxiv-id> <text>
 *
 * Behaviour:
 *   1. Look up the paper by arxiv ID.
 *   2. Find the most recent feedback row for that paper.
 *   3. Append the note text to any existing note (separator: " | "), or set it if empty.
 *   4. If no feedback row exists, record a standalone note in user_interactions.
 *   5. Return a confirmation with the paper title and updated note preview.
 *
 * The note is stored in:
 *   - paper_feedback.reason (the notes/reason column — used for free-text notes)
 *   - user_interactions.metadata (JSON, for standalone notes with no prior feedback)
 *
 * This is intentionally simple: no note history, no per-type targeting.
 * Mikey uses it to jot a thought about a paper after giving feedback earlier.
 */

import type { Db } from '../db.js';

export interface NoteOptions {
  db: Db;
  arxivId: string;
  noteText: string;
}

export type NoteResult =
  | { ok: true; paper: { arxivId: string; title: string }; previousNote: string | null; updatedNote: string; hadFeedback: boolean }
  | { ok: false; error: 'paper_not_found' | 'db_error'; message: string };

/**
 * Append/update a note on the most recent feedback row for a paper.
 * Falls back to a standalone user_interaction record if no feedback exists.
 */
export function addNote(opts: NoteOptions): NoteResult {
  const { db, arxivId, noteText } = opts;

  // 1. Look up paper
  const paperRow = db.sqlite
    .prepare('SELECT arxiv_id, title FROM papers WHERE arxiv_id = ?')
    .get(arxivId) as { arxiv_id: string; title: string } | undefined;

  if (!paperRow) {
    return {
      ok: false,
      error: 'paper_not_found',
      message: `Paper not found: ${arxivId}`,
    };
  }

  const paper = { arxivId: paperRow.arxiv_id, title: paperRow.title };

  try {
    // 2. Find the most recent feedback row
    const feedbackRow = db.sqlite
      .prepare(
        `SELECT id, reason FROM paper_feedback
         WHERE paper_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(arxivId) as { id: string; reason: string | null } | undefined;

    if (feedbackRow) {
      // 3. Append to existing note (or set it)
      const previousNote = feedbackRow.reason ?? null;
      const updatedNote = previousNote
        ? `${previousNote} | ${noteText}`
        : noteText;

      db.sqlite
        .prepare('UPDATE paper_feedback SET reason = ? WHERE id = ?')
        .run(updatedNote, feedbackRow.id);

      return { ok: true, paper, previousNote, updatedNote, hadFeedback: true };
    }

    // 4. No feedback — record a standalone note interaction
    const uuid = crypto.randomUUID();
    db.sqlite
      .prepare(
        `INSERT INTO user_interactions
           (id, interaction_type, paper_id, command, signal_strength, metadata)
         VALUES (?, 'note_added', ?, 'note', 0, ?)`,
      )
      .run(
        uuid,
        arxivId,
        JSON.stringify({ source: 'signal', note: noteText }),
      );

    return {
      ok: true,
      paper,
      previousNote: null,
      updatedNote: noteText,
      hadFeedback: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'db_error', message: msg };
  }
}

/**
 * Format a Signal-friendly confirmation of the note update.
 */
export function formatNoteReply(result: Extract<NoteResult, { ok: true }>): string {
  const { paper, updatedNote, hadFeedback } = result;

  const truncatedTitle =
    paper.title.length > 60 ? paper.title.slice(0, 57) + '…' : paper.title;

  const preview =
    updatedNote.length > 120 ? updatedNote.slice(0, 117) + '…' : updatedNote;

  const context = hadFeedback
    ? '📝 Note saved (attached to your feedback).'
    : '📝 Note saved (no prior feedback — stored as a standalone note).';

  return `${context}\n"${truncatedTitle}"\n\n💬 ${preview}`;
}
