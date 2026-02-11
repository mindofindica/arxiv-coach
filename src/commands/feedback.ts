/**
 * Feedback Tracking CLI Commands
 * Proof-of-concept implementation for user feedback collection and analysis
 *
 * Usage (via tsx):
 *   tsx src/commands/feedback.ts read <paper-id> [--notes "..."]
 *   tsx src/commands/feedback.ts skip <paper-id> [--reason "too theoretical"]
 *   tsx src/commands/feedback.ts save <paper-id> [--notes "..."] [--priority 5]
 *   tsx src/commands/feedback.ts love <paper-id> [--notes "..."]
 *   tsx src/commands/feedback.ts meh <paper-id>
 *   tsx src/commands/feedback.ts summary [--last 7]
 *   tsx src/commands/feedback.ts track-stats [--last 30]
 *   tsx src/commands/feedback.ts reading-list [--status unread]
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../lib/config.js';
import { openDb, type Db } from '../lib/db.js';

// ── Helpers ────────────────────────────────────────────────────────────

function getDb(): Db {
  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  ensureFeedbackTables(db);
  return db;
}

function ensureFeedbackTables(db: Db): void {
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

    CREATE TABLE IF NOT EXISTS track_performance (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      track_name TEXT NOT NULL,
      week_start_date TEXT NOT NULL,
      papers_sent INTEGER DEFAULT 0,
      papers_viewed INTEGER DEFAULT 0,
      papers_read INTEGER DEFAULT 0,
      papers_skipped INTEGER DEFAULT 0,
      papers_saved INTEGER DEFAULT 0,
      papers_loved INTEGER DEFAULT 0,
      avg_signal_strength REAL DEFAULT 0,
      engagement_rate_pct REAL DEFAULT 0,
      UNIQUE(track_name, week_start_date)
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
  `);
}

function uuid(): string {
  return crypto.randomUUID();
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next: string | undefined = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ── Paper resolution ───────────────────────────────────────────────────

interface PaperRow {
  id: string;
  title: string;
  arxiv_id: string;
}

function resolvePaper(db: Db, identifier: string): PaperRow | null {
  // Try as arxiv ID
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(identifier)) {
    const row = db.sqlite
      .prepare('SELECT id, title, arxiv_id FROM papers WHERE arxiv_id = ?')
      .get(identifier) as PaperRow | undefined;
    return row ?? null;
  }

  // Try as position (recent papers)
  const pos = parseInt(identifier, 10);
  if (!isNaN(pos) && pos > 0) {
    const rows = db.sqlite
      .prepare('SELECT id, title, arxiv_id FROM papers ORDER BY created_at DESC LIMIT ?')
      .all(10) as PaperRow[];
    return rows[pos - 1] ?? null;
  }

  // Try as UUID/id
  const row = db.sqlite
    .prepare('SELECT id, title, arxiv_id FROM papers WHERE id = ?')
    .get(identifier) as PaperRow | undefined;
  return row ?? null;
}

// ── Feedback recording ─────────────────────────────────────────────────

const SIGNAL_STRENGTHS: Record<string, number> = {
  love: 10,
  read: 8,
  save: 5,
  meh: -2,
  skip: -5,
};

function recordFeedback(
  db: Db,
  paperId: string,
  feedbackType: string,
  reason: string | null,
): void {
  const paper = resolvePaper(db, paperId);
  if (!paper) {
    console.error(`Paper not found: ${paperId}`);
    process.exit(1);
  }

  const signalStrength = SIGNAL_STRENGTHS[feedbackType] ?? 0;

  // Insert feedback (ignore if duplicate)
  const existing = db.sqlite
    .prepare('SELECT id FROM paper_feedback WHERE paper_id = ? AND feedback_type = ?')
    .get(paper.id, feedbackType) as { id: string } | undefined;

  if (existing) {
    console.log(`Already marked as ${feedbackType}`);
    return;
  }

  db.sqlite
    .prepare(
      `INSERT INTO paper_feedback (id, paper_id, feedback_type, reason)
       VALUES (?, ?, ?, ?)`,
    )
    .run(uuid(), paper.id, feedbackType, reason);

  // Log interaction
  db.sqlite
    .prepare(
      `INSERT INTO user_interactions (id, interaction_type, paper_id, command, signal_strength)
       VALUES (?, 'feedback_given', ?, ?, ?)`,
    )
    .run(uuid(), paper.id, feedbackType, signalStrength);

  const icons: Record<string, string> = {
    love: '❤️',
    read: '✅',
    save: '⭐',
    skip: '⏭️',
    meh: '😐',
  };

  console.log(`${icons[feedbackType] ?? '📝'} Feedback recorded: ${feedbackType}`);
  console.log(`  ${paper.title}`);
  if (reason) console.log(`  Reason: ${reason}`);

  if (feedbackType === 'skip' || feedbackType === 'meh') {
    console.log('  💡 System will deprioritize similar papers in future');
  } else if (feedbackType === 'read' || feedbackType === 'love') {
    console.log('  💡 System will boost similar papers in future');
  }
}

// ── Commands ───────────────────────────────────────────────────────────

function cmdFeedback(db: Db, type: string, paperId: string, flags: Record<string, string>): void {
  const reason = flags.reason ?? flags.notes ?? null;
  recordFeedback(db, paperId, type, reason);

  // If save, also add to reading list
  if (type === 'save') {
    const paper = resolvePaper(db, paperId);
    if (paper) {
      const priority = parseInt(flags.priority ?? '5', 10);
      const existing = db.sqlite
        .prepare('SELECT id FROM reading_list WHERE paper_id = ?')
        .get(paper.id) as { id: string } | undefined;

      if (!existing) {
        db.sqlite
          .prepare(
            `INSERT INTO reading_list (id, paper_id, priority, notes) VALUES (?, ?, ?, ?)`,
          )
          .run(uuid(), paper.id, priority, flags.notes ?? null);
        console.log(`  📚 Added to reading list (priority ${priority}/10)`);
      }
    }
  }
}

interface FeedbackRow {
  feedback_type: string;
}

interface InteractionRow {
  paper_id: string | null;
  signal_strength: number | null;
}

function cmdSummary(db: Db, flags: Record<string, string>): void {
  const days = parseInt(flags.last ?? '7', 10);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  const interactions = db.sqlite
    .prepare('SELECT paper_id, signal_strength FROM user_interactions WHERE created_at >= ?')
    .all(sinceIso) as InteractionRow[];

  const feedbacks = db.sqlite
    .prepare('SELECT feedback_type FROM paper_feedback WHERE created_at >= ?')
    .all(sinceIso) as FeedbackRow[];

  const uniquePapers = new Set(interactions.filter((i) => i.paper_id).map((i) => i.paper_id)).size;
  const totalInteractions = interactions.length;
  const avgSignal =
    totalInteractions > 0
      ? interactions.reduce((sum, i) => sum + (i.signal_strength ?? 0), 0) / totalInteractions
      : 0;

  const feedbackCounts: Record<string, number> = {};
  for (const f of feedbacks) {
    feedbackCounts[f.feedback_type] = (feedbackCounts[f.feedback_type] ?? 0) + 1;
  }

  console.log(`\n📊 Engagement Summary (last ${days} days)\n`);
  console.log('Overall Activity:');
  console.log(`  Papers engaged with: ${uniquePapers}`);
  console.log(`  Total interactions: ${totalInteractions}`);
  console.log(`  Average signal: ${avgSignal.toFixed(1)}/10`);
  console.log();

  console.log('Explicit Feedback:');
  const icons: Record<string, string> = {
    love: '❤️',
    read: '✅',
    save: '⭐',
    skip: '⏭️',
    meh: '😐',
  };

  if (Object.keys(feedbackCounts).length > 0) {
    for (const [type, count] of Object.entries(feedbackCounts)) {
      console.log(`  ${icons[type] ?? '📝'} ${type}: ${count}`);
    }
  } else {
    console.log('  No explicit feedback yet.');
  }
}

interface TrackRow {
  track_name: string;
  papers_sent: number;
  papers_read: number;
  papers_skipped: number;
  engagement_rate_pct: number;
}

function cmdTrackStats(db: Db, _flags: Record<string, string>): void {
  const stats = db.sqlite
    .prepare('SELECT * FROM track_performance ORDER BY engagement_rate_pct DESC')
    .all() as TrackRow[];

  if (stats.length === 0) {
    console.log('No track data yet.');
    return;
  }

  console.log('\n📈 Track Performance\n');

  for (const track of stats) {
    console.log(track.track_name);
    console.log(`  Papers sent: ${track.papers_sent}`);
    console.log(`  Papers read: ${track.papers_read}`);
    console.log(`  Engagement rate: ${track.engagement_rate_pct}%`);

    if (track.engagement_rate_pct >= 70) {
      console.log('  ✅ High value track - consider boosting');
    } else if (track.engagement_rate_pct < 25) {
      console.log('  ⚠️  Low engagement - consider removing');
    }
    console.log();
  }
}

interface ReadingListRow {
  id: string;
  paper_id: string;
  status: string;
  priority: number;
  notes: string | null;
  created_at: string;
  title: string | null;
  arxiv_id: string | null;
}

function cmdReadingList(db: Db, flags: Record<string, string>): void {
  const status = flags.status;
  const limit = parseInt(flags.limit ?? '20', 10);

  let sql = `SELECT rl.*, p.title, p.arxiv_id
    FROM reading_list rl
    LEFT JOIN papers p ON rl.paper_id = p.id`;
  const params: unknown[] = [];

  if (status) {
    sql += ' WHERE rl.status = ?';
    params.push(status);
  } else {
    sql += " WHERE rl.status IN ('unread', 'in_progress')";
  }

  sql += ' ORDER BY rl.priority DESC, rl.created_at DESC LIMIT ?';
  params.push(limit);

  const items = db.sqlite.prepare(sql).all(...params) as ReadingListRow[];

  if (items.length === 0) {
    console.log('Reading list is empty.');
    return;
  }

  const statusIcons: Record<string, string> = {
    read: '✅',
    in_progress: '📖',
    unread: '📄',
  };

  console.log(`\n📚 Reading List (${items.length})\n`);

  items.forEach((item, idx) => {
    const icon = statusIcons[item.status] ?? '📄';
    console.log(`${idx + 1}. ${icon} ${item.title ?? 'Unknown'}`);
    console.log(`   ArXiv: ${item.arxiv_id ?? 'N/A'} | Priority: ${item.priority}/10`);
    if (item.notes) console.log(`   Notes: ${item.notes}`);
    console.log(`   Saved: ${item.created_at}`);
    console.log();
  });
}

// ── Main ───────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const { positional, flags } = parseArgs(rawArgs);
const command = positional[0];

if (!command) {
  console.log(
    'Usage: tsx src/commands/feedback.ts <read|skip|save|love|meh|summary|track-stats|reading-list> [args] [--flags]',
  );
  process.exit(0);
}

const db = getDb();

switch (command) {
  case 'read':
  case 'skip':
  case 'save':
  case 'love':
  case 'meh': {
    const paperId = positional[1];
    if (!paperId) {
      console.error(`Usage: feedback ${command} <paper-id>`);
      process.exit(1);
    }
    cmdFeedback(db, command, paperId, flags);
    break;
  }
  case 'summary':
    cmdSummary(db, flags);
    break;
  case 'track-stats':
    cmdTrackStats(db, flags);
    break;
  case 'reading-list':
    cmdReadingList(db, flags);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
