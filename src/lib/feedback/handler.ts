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
import { getWeeklySummary } from '../query/weekly-summary.js';
import { renderWeeklySummaryMessage } from '../query/render-weekly-summary.js';
import { searchPapers, formatSearchReply } from '../search/search.js';
import { recommendPapers, formatRecommendReply } from '../recommend/recommend.js';
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

// ── Status snapshot ────────────────────────────────────────────────────────

interface DigestRow {
  sent_at: string | null;
  paper_count: number;
  track_name: string | null;
}

interface StatusSnapshot {
  papersTotal: number;
  papersThisWeek: number;
  lastDigestAt: string | null;
  lastDigestCount: number;
  readingListUnread: number;
  readingListTotal: number;
  feedbackThisWeek: number;
}

function getStatusSnapshot(db: Db): StatusSnapshot {
  // Total papers ingested
  const papersTotal = (db.sqlite.prepare('SELECT COUNT(*) as n FROM papers').get() as { n: number }).n;

  // Papers ingested in last 7 days
  const papersThisWeek = (
    db.sqlite
      .prepare(`SELECT COUNT(*) as n FROM papers WHERE ingested_at >= datetime('now', '-7 days')`)
      .get() as { n: number }
  ).n;

  // Last digest (try digests table, fall back gracefully)
  let lastDigestAt: string | null = null;
  let lastDigestCount = 0;
  try {
    const digestRow = db.sqlite
      .prepare(
        `SELECT sent_at, paper_count, track_name FROM digests
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get() as DigestRow | undefined;
    lastDigestAt = digestRow?.sent_at ?? null;
    lastDigestCount = digestRow?.paper_count ?? 0;
  } catch {
    // digests table may not exist — skip silently
  }

  // Reading list
  const readingListUnread = (
    db.sqlite
      .prepare(`SELECT COUNT(*) as n FROM reading_list WHERE status IN ('unread', 'in_progress')`)
      .get() as { n: number }
  ).n;

  const readingListTotal = (
    db.sqlite.prepare('SELECT COUNT(*) as n FROM reading_list').get() as { n: number }
  ).n;

  // Feedback this week
  const feedbackThisWeek = (
    db.sqlite
      .prepare(
        `SELECT COUNT(*) as n FROM paper_feedback WHERE created_at >= datetime('now', '-7 days')`,
      )
      .get() as { n: number }
  ).n;

  return {
    papersTotal,
    papersThisWeek,
    lastDigestAt,
    lastDigestCount,
    readingListUnread,
    readingListTotal,
    feedbackThisWeek,
  };
}

function formatStatusReply(snap: StatusSnapshot): string {
  const lines: string[] = ['📡 arxiv-coach status'];
  lines.push('');

  // Last digest
  if (snap.lastDigestAt) {
    const d = new Date(snap.lastDigestAt);
    const hoursAgo = Math.round((Date.now() - d.getTime()) / 3_600_000);
    const timeLabel = hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.round(hoursAgo / 24)}d ago`;
    lines.push(`📬 Last digest: ${timeLabel} (${snap.lastDigestCount} papers)`);
  } else {
    lines.push('📬 Last digest: none yet');
  }

  // Papers
  lines.push(`📄 Papers in DB: ${snap.papersTotal} total, ${snap.papersThisWeek} this week`);

  // Reading list
  lines.push(
    `📚 Reading list: ${snap.readingListUnread} unread / ${snap.readingListTotal} saved`,
  );

  // Feedback
  lines.push(`✍️ Feedback this week: ${snap.feedbackThisWeek} papers rated`);

  // Overall health indicator
  lines.push('');
  if (snap.papersThisWeek > 0 || snap.feedbackThisWeek > 0) {
    lines.push('✅ System healthy');
  } else {
    lines.push('⚠️ No activity this week — check cron jobs');
  }

  return lines.join('\n');
}

function handleStatusQuery(db: Db): HandleResult {
  try {
    const snap = getStatusSnapshot(db);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: formatStatusReply(snap),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Error fetching status: ${msg}`,
    };
  }
}

// ── Stats query ────────────────────────────────────────────────────────────

interface FeedbackCountRow {
  feedback_type: string;
  cnt: number;
}

interface TrackStatsRow {
  track_name: string;
  cnt: number;
}

function handleStatsQuery(db: Db, query: ParsedQuery): HandleResult {
  const days = query.days ?? 7;
  const sinceExpr = `datetime('now', '-${days} days')`;

  try {
    // Feedback breakdown
    const feedbackCounts = db.sqlite
      .prepare(
        `SELECT feedback_type, COUNT(*) as cnt FROM paper_feedback
         WHERE created_at >= ${sinceExpr}
         GROUP BY feedback_type
         ORDER BY cnt DESC`,
      )
      .all() as FeedbackCountRow[];

    // Papers ingested this window
    const papersIngested = (
      db.sqlite
        .prepare(`SELECT COUNT(*) as n FROM papers WHERE ingested_at >= ${sinceExpr}`)
        .get() as { n: number }
    ).n;

    // Top tracks by paper count (via digests, if available)
    let topTracks: TrackStatsRow[] = [];
    try {
      topTracks = db.sqlite
        .prepare(
          `SELECT track_name, COUNT(*) as cnt FROM digests
           WHERE sent_at >= ${sinceExpr} AND track_name IS NOT NULL
           GROUP BY track_name ORDER BY cnt DESC LIMIT 3`,
        )
        .all() as TrackStatsRow[];
    } catch {
      // digests table may not exist
    }

    // Format reply
    const lines: string[] = [`📊 Stats (last ${days} days)`];
    lines.push('');

    lines.push(`📄 Papers ingested: ${papersIngested}`);
    lines.push('');

    const ICONS: Record<string, string> = {
      love: '❤️',
      read: '✅',
      save: '⭐',
      skip: '⏭️',
      meh: '😐',
    };

    if (feedbackCounts.length > 0) {
      lines.push('Feedback:');
      for (const row of feedbackCounts) {
        const icon = ICONS[row.feedback_type] ?? '📝';
        lines.push(`  ${icon} ${row.feedback_type}: ${row.cnt}`);
      }
      const total = feedbackCounts.reduce((s, r) => s + r.cnt, 0);
      lines.push(`  Total: ${total}`);
    } else {
      lines.push('Feedback: none this period');
    }

    if (topTracks.length > 0) {
      lines.push('');
      lines.push('Top tracks:');
      for (const t of topTracks) {
        lines.push(`  • ${t.track_name} (${t.cnt} digests)`);
      }
    }

    return {
      shouldReply: true,
      wasCommand: true,
      reply: lines.join('\n'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Error fetching stats: ${msg}`,
    };
  }
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

// ── Weekly summary ─────────────────────────────────────────────────────────

/**
 * Return the current ISO week string, e.g. "2026-W08".
 * Uses the ISO 8601 definition: week 1 is the week containing the year's first Thursday.
 */
function getCurrentIsoWeek(): string {
  const now = new Date();
  // Thursday of the current week (ISO: Mon=1, Thu=4)
  const thu = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = thu.getUTCDay() || 7; // convert Sun=0 to 7
  thu.setUTCDate(thu.getUTCDate() + 4 - day); // snap to Thursday

  const jan1 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((thu.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);

  return `${thu.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function handleWeeklyQuery(db: Db, query: ParsedQuery): HandleResult {
  const weekIso = query.week ?? getCurrentIsoWeek();

  try {
    const summary = getWeeklySummary(db, weekIso);

    // Apply track filter if requested
    if (query.track) {
      const filterLower = query.track.toLowerCase();
      summary.trackStats = summary.trackStats.filter(t =>
        t.trackName.toLowerCase().includes(filterLower)
      );
      summary.topPapers = summary.topPapers.filter(p =>
        p.tracks.some(t => t.toLowerCase().includes(filterLower))
      );
    }

    const { text } = renderWeeklySummaryMessage(summary);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: text,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Error fetching weekly summary for ${weekIso}: ${msg}`,
    };
  }
}

// ── Search query ───────────────────────────────────────────────────────────

function handleSearchQuery(db: Db, query: ParsedQuery): HandleResult {
  const { searchQuery, limit, track, from } = query;

  if (!searchQuery) {
    return {
      shouldReply: true,
      wasCommand: true,
      reply:
        '⚠️ Usage: /search <query>\n\n' +
        'Examples:\n' +
        '  /search speculative decoding\n' +
        '  /search "retrieval augmented generation"\n' +
        '  /search LoRA --limit 10\n' +
        '  /search agent --track LLM\n' +
        '  /search RLHF --from 2026',
    };
  }

  try {
    const resp = searchPapers(db, {
      query: searchQuery,
      limit,
      track,
      from,
    });

    return {
      shouldReply: true,
      wasCommand: true,
      reply: formatSearchReply(resp),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Search error: ${msg}`,
    };
  }
}

// ── Recommend query ────────────────────────────────────────────────────────

function handleRecommendQuery(db: Db, query: ParsedQuery): HandleResult {
  const { limit, track } = query;

  try {
    const resp = recommendPapers(db, { limit, track });
    return {
      shouldReply: true,
      wasCommand: true,
      reply: formatRecommendReply(resp),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shouldReply: true,
      wasCommand: true,
      reply: `❌ Recommend error: ${msg}`,
    };
  }
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
        if (parsed.query.command === 'status') {
          return handleStatusQuery(db);
        }
        if (parsed.query.command === 'stats') {
          return handleStatsQuery(db, parsed.query);
        }
        if (parsed.query.command === 'weekly') {
          return handleWeeklyQuery(db, parsed.query);
        }
        if (parsed.query.command === 'search') {
          return handleSearchQuery(db, parsed.query);
        }
        if (parsed.query.command === 'recommend') {
          return handleRecommendQuery(db, parsed.query);
        }
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
