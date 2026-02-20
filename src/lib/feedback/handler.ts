/**
 * Signal Feedback Handler
 *
 * High-level entry point: takes a raw Signal message, parses it,
 * records feedback in the DB (or runs a query), and returns a
 * response string to send back to Signal.
 *
 * Usage:
 *   const handler = createFeedbackHandler({ dbPath, repoRoot });
 *   const result = handler.handle("/read 2403.12345");
 *   if (result.shouldReply) console.log(result.reply);
 *
 *   const list = handler.handle("/reading-list --status unread --limit 5");
 *   if (list.shouldReply) console.log(list.reply);
 */

import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDb, migrate } from '../db.js';
import { ensureFeedbackTables } from './migrate.js';
import { parseFeedbackMessage, type ParsedQuery } from './parser.js';
import { recordFeedback, formatConfirmation } from './recorder.js';
import type { Db } from '../db.js';

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

// ── Reading list query ─────────────────────────────────────────────────────

interface ReadingListRow {
  paper_id: string;
  priority: number | null;
  notes: string | null;
  status: string;
  added_at: string;
  title: string | null;
  url: string | null;
}

/**
 * Format the reading list as a Signal-friendly reply.
 * Signal doesn't support markdown tables, so we use a simple numbered list.
 */
function formatReadingList(rows: ReadingListRow[], query: ParsedQuery): string {
  const { status, limit } = query;

  if (rows.length === 0) {
    const statusLabel = status === 'all' ? '' : ` (${status})`;
    return `📚 Reading list${statusLabel}: nothing here yet.\n\nSend /save <arxiv-id> to add a paper.`;
  }

  const statusLabel = status === 'all' ? 'all' : status === 'read' ? 'read' : 'unread';
  const lines: string[] = [`📚 Reading list (${statusLabel}, ${rows.length} of max ${limit}):`];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const num = i + 1;
    const title = row.title ?? row.paper_id;
    // Truncate title at 60 chars to keep Signal messages scannable
    const shortTitle = title.length > 60 ? title.slice(0, 57) + '…' : title;
    const arxivId = row.paper_id;
    const priorityStr = row.priority != null ? ` [p${row.priority}]` : '';
    const statusStr = row.status === 'read' ? ' ✓' : '';

    lines.push(`${num}. ${shortTitle}${priorityStr}${statusStr}`);
    lines.push(`   arxiv:${arxivId}`);
    if (row.notes) {
      const shortNotes = row.notes.length > 80 ? row.notes.slice(0, 77) + '…' : row.notes;
      lines.push(`   📝 ${shortNotes}`);
    }
  }

  lines.push('');
  lines.push('Commands: /read <id> · /skip <id> · /love <id>');

  return lines.join('\n');
}

function handleReadingListQuery(db: Db, query: ParsedQuery): HandleResult {
  const { status, limit } = query;

  let rows: ReadingListRow[];

  try {
    if (status === 'all') {
      rows = db.sqlite
        .prepare(
          `SELECT rl.paper_id, rl.priority, rl.notes, rl.status, rl.created_at as added_at,
                  p.title, ('https://arxiv.org/abs/' || rl.paper_id) as url
           FROM reading_list rl
           LEFT JOIN papers p ON p.arxiv_id = rl.paper_id
           ORDER BY rl.priority DESC NULLS LAST, rl.created_at DESC
           LIMIT ?`,
        )
        .all(limit) as ReadingListRow[];
    } else {
      rows = db.sqlite
        .prepare(
          `SELECT rl.paper_id, rl.priority, rl.notes, rl.status, rl.created_at as added_at,
                  p.title, ('https://arxiv.org/abs/' || rl.paper_id) as url
           FROM reading_list rl
           LEFT JOIN papers p ON p.arxiv_id = rl.paper_id
           WHERE rl.status = ?
           ORDER BY rl.priority DESC NULLS LAST, rl.created_at DESC
           LIMIT ?`,
        )
        .all(status, limit) as ReadingListRow[];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Error querying reading list: ${msg}`,
    };
  }

  return {
    shouldReply: true,
    wasCommand: true,
    reply: formatReadingList(rows, query),
  };
}

// ── Handler factory ────────────────────────────────────────────────────────

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

      // ── Query commands ────────────────────────────────────────────────
      if (parsed.kind === 'query') {
        if (parsed.query.command === 'reading-list') {
          return handleReadingListQuery(db, parsed.query);
        }
        // Future query commands handled here
        return { shouldReply: false, wasCommand: false };
      }

      // ── Feedback commands ─────────────────────────────────────────────
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
