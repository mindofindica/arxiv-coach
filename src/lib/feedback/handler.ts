/**
 * Signal Feedback Handler
 *
 * High-level entry point: takes a raw Signal message, parses it,
 * records feedback in the DB, and returns a response string to send back.
 *
 * Usage:
 *   const handler = createFeedbackHandler({ dbPath, repoRoot });
 *   const result = await handler.handle("/read 2403.12345");
 *   if (result.shouldReply) console.log(result.reply);
 */

import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb, migrate } from '../db.js';
import { ensureFeedbackTables } from './migrate.js';
import { parseFeedbackMessage } from './parser.js';
import { recordFeedback, formatConfirmation } from './recorder.js';

export interface HandlerOptions {
  /** Absolute path to db.sqlite. Defaults to <repoRoot>/data/db.sqlite */
  dbPath?: string;
  /** Root of the arxiv-coach repo (for config.yml). Defaults to cwd. */
  repoRoot?: string;
}

export interface HandleResult {
  /** Whether to send a reply back to Signal */
  shouldReply: boolean;
  /** The reply text (only when shouldReply = true) */
  reply?: string;
  /** Whether the message was a recognised feedback command */
  wasCommand: boolean;
  /** Parsed arxiv ID if applicable */
  arxivId?: string;
}

export function createFeedbackHandler(opts: HandlerOptions = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const config = loadConfig(repoRoot);
  const dbPath = opts.dbPath ?? path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);
  ensureFeedbackTables(db);

  return {
    /**
     * Handle a raw Signal message. Returns structured result.
     */
    handle(messageText: string): HandleResult {
      const parsed = parseFeedbackMessage(messageText);

      if (!parsed.ok) {
        if (parsed.error === 'not_a_command') {
          // Not a feedback command — ignore silently
          return { shouldReply: false, wasCommand: false };
        }

        // Recognised as a command attempt but malformed
        return {
          shouldReply: true,
          wasCommand: true,
          reply: `⚠️ ${parsed.message}`,
        };
      }

      const { feedbackType, arxivId, notes, reason, priority } = parsed.feedback;

      const result = recordFeedback({
        db,
        arxivId,
        feedbackType,
        notes,
        reason,
        priority,
      });

      if (!result.ok) {
        if (result.error === 'paper_not_found') {
          return {
            shouldReply: true,
            wasCommand: true,
            arxivId,
            reply: `❓ Paper not found in local DB: ${arxivId}\n\nEither the paper hasn't been ingested yet, or the arxiv ID is wrong. Check https://arxiv.org/abs/${arxivId}`,
          };
        }

        return {
          shouldReply: true,
          wasCommand: true,
          arxivId,
          reply: `❌ Error recording feedback: ${result.message}`,
        };
      }

      return {
        shouldReply: true,
        wasCommand: true,
        arxivId,
        reply: formatConfirmation(result, feedbackType),
      };
    },

    /** Close the DB connection */
    close() {
      db.sqlite.close();
    },
  };
}
