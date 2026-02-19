/**
 * Feedback tables migration helper.
 *
 * Creates the feedback-related tables if they don't exist.
 * Called by the handler during initialisation.
 *
 * Note: These tables are deliberately NOT part of the core schema_meta
 * versioning system (which is reserved for arxiv data schemas).
 * They're additive and idempotent, so CREATE TABLE IF NOT EXISTS is fine.
 */

import type { Db } from '../db.js';

export function ensureFeedbackTables(db: Db): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_interactions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      interaction_type TEXT NOT NULL,
      paper_id TEXT,
      digest_id TEXT,
      track_name TEXT,
      command TEXT,
      signal_strength INTEGER,
      position_in_digest INTEGER,
      time_since_digest_sent_sec INTEGER,
      session_id TEXT,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS paper_feedback (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paper_id TEXT NOT NULL,
      feedback_type TEXT NOT NULL,
      reason TEXT,
      tags TEXT DEFAULT '[]',
      expected_track TEXT,
      actual_interest_level INTEGER,
      UNIQUE(paper_id, feedback_type)
    );

    CREATE TABLE IF NOT EXISTS reading_list (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paper_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      priority INTEGER DEFAULT 5,
      notes TEXT,
      read_at TEXT,
      UNIQUE(paper_id)
    );

    CREATE INDEX IF NOT EXISTS idx_paper_feedback_paper_id ON paper_feedback(paper_id);
    CREATE INDEX IF NOT EXISTS idx_paper_feedback_type ON paper_feedback(feedback_type);
    CREATE INDEX IF NOT EXISTS idx_user_interactions_created ON user_interactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_reading_list_status ON reading_list(status);
    CREATE INDEX IF NOT EXISTS idx_reading_list_priority ON reading_list(priority DESC);
  `);
}
