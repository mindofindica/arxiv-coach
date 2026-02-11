/**
 * Gap Detector CLI Commands
 * Proof-of-concept implementation for knowledge gap tracking
 *
 * Usage (via tsx):
 *   tsx src/commands/gap.ts mark "concept" [--paper arxiv:1234.5678] [--context "..."] [--tags "a,b"]
 *   tsx src/commands/gap.ts list [--status identified] [--limit 10] [--all]
 *   tsx src/commands/gap.ts learn <gap-id> [--type micro]
 *   tsx src/commands/gap.ts understood <gap-id> [--feedback helpful] [--notes "..."]
 *   tsx src/commands/gap.ts history [--limit 20] [--gap-id <id>]
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
  ensureGapTables(db);
  return db;
}

function ensureGapTables(db: Db): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_gaps (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      concept TEXT NOT NULL,
      context TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      paper_title TEXT,
      arxiv_id TEXT,
      detection_method TEXT NOT NULL,
      original_message TEXT,
      status TEXT NOT NULL DEFAULT 'identified',
      priority INTEGER DEFAULT 50,
      lesson_generated_at TEXT,
      lesson_sent_at TEXT,
      marked_understood_at TEXT,
      tags TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      gap_id TEXT NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
      lesson_type TEXT NOT NULL,
      lesson_content TEXT NOT NULL,
      lesson_format TEXT DEFAULT 'text',
      delivered_via TEXT,
      delivered_at TEXT DEFAULT (datetime('now')),
      read INTEGER DEFAULT 0,
      read_at TEXT,
      feedback TEXT,
      feedback_text TEXT,
      generation_model TEXT
    );

    CREATE TABLE IF NOT EXISTS gap_relationships (
      id TEXT PRIMARY KEY,
      parent_gap_id TEXT NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
      child_gap_id TEXT NOT NULL REFERENCES knowledge_gaps(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL
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

// ── Commands ───────────────────────────────────────────────────────────

function cmdMark(db: Db, concept: string, flags: Record<string, string>): void {
  const tags = flags.tags ? flags.tags.split(',').map((t) => t.trim()) : [];

  let paperTitle: string | null = null;
  if (flags.paper) {
    const row = db.sqlite
      .prepare('SELECT title FROM papers WHERE arxiv_id = ?')
      .get(flags.paper) as { title: string } | undefined;
    paperTitle = row?.title ?? null;
  }

  const id = uuid();
  db.sqlite
    .prepare(
      `INSERT INTO knowledge_gaps
        (id, concept, context, source_type, arxiv_id, paper_title, detection_method, original_message, tags)
       VALUES (?, ?, ?, ?, ?, ?, 'explicit_command', ?, ?)`,
    )
    .run(
      id,
      concept,
      flags.context ?? null,
      flags.paper ? 'paper' : 'manual',
      flags.paper ?? null,
      paperTitle,
      `gap mark "${concept}"`,
      JSON.stringify(tags),
    );

  console.log(`✓ Gap tracked!`);
  console.log(`  ID: ${id}`);
  console.log(`  Concept: ${concept}`);
  if (paperTitle) console.log(`  From: ${paperTitle} (${flags.paper})`);
  console.log(`  Priority: 50/100`);
  console.log(`  📚 Will include micro-lesson in next relevant digest`);
}

interface GapRow {
  id: string;
  concept: string;
  context: string | null;
  status: string;
  priority: number;
  created_at: string;
  paper_title: string | null;
  arxiv_id: string | null;
  tags: string;
}

function cmdList(db: Db, flags: Record<string, string>): void {
  const limit = parseInt(flags.limit ?? '10', 10);
  const showAll = flags.all === 'true';
  const status = flags.status;

  let sql = 'SELECT * FROM knowledge_gaps';
  const params: unknown[] = [];

  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  } else if (!showAll) {
    sql += " WHERE status IN ('identified', 'lesson_queued', 'lesson_sent')";
  }

  sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?';
  params.push(limit);

  const gaps = db.sqlite.prepare(sql).all(...params) as GapRow[];

  if (gaps.length === 0) {
    console.log('No gaps found.');
    return;
  }

  console.log(`\n📚 Knowledge Gaps (${gaps.length})\n`);

  gaps.forEach((gap, idx) => {
    console.log(`${idx + 1}. ${gap.concept}`);
    console.log(`   Priority: ${gap.priority}/100 | Status: ${gap.status}`);
    if (gap.context) {
      const truncated = gap.context.length > 80 ? gap.context.substring(0, 77) + '...' : gap.context;
      console.log(`   Context: "${truncated}"`);
    }
    if (gap.paper_title) console.log(`   From: ${gap.paper_title} (${gap.arxiv_id})`);
    const tags = JSON.parse(gap.tags || '[]') as string[];
    if (tags.length > 0) console.log(`   Tags: ${tags.join(', ')}`);
    console.log(`   ID: ${gap.id}\n`);
  });
}

function cmdLearn(db: Db, gapId: string, flags: Record<string, string>): void {
  const lessonType = flags.type ?? 'micro';

  const gap = db.sqlite.prepare('SELECT * FROM knowledge_gaps WHERE id = ?').get(gapId) as GapRow | undefined;
  if (!gap) {
    console.error('Gap not found');
    process.exit(1);
  }

  console.log(`\n🎯 Generating ${lessonType} lesson for: ${gap.concept}\n`);

  const lessonContent = generateLesson(gap, lessonType);
  console.log(lessonContent);

  const sessionId = uuid();
  db.sqlite
    .prepare(
      `INSERT INTO learning_sessions (id, gap_id, lesson_type, lesson_content, delivered_via, generation_model)
       VALUES (?, ?, ?, ?, 'cli', 'template-poc')`,
    )
    .run(sessionId, gapId, lessonType, lessonContent);

  db.sqlite
    .prepare(
      `UPDATE knowledge_gaps SET status = 'lesson_sent',
        lesson_generated_at = datetime('now'), lesson_sent_at = datetime('now')
       WHERE id = ?`,
    )
    .run(gapId);

  console.log('\n✓ Lesson saved to database');
}

function cmdUnderstood(db: Db, gapId: string, flags: Record<string, string>): void {
  const result = db.sqlite
    .prepare("UPDATE knowledge_gaps SET status = 'understood', marked_understood_at = datetime('now') WHERE id = ?")
    .run(gapId);

  if (result.changes === 0) {
    console.error('Gap not found');
    process.exit(1);
  }

  if (flags.feedback || flags.notes) {
    db.sqlite
      .prepare(
        `UPDATE learning_sessions SET feedback = ?, feedback_text = ?, read = 1, read_at = datetime('now')
         WHERE gap_id = ? ORDER BY delivered_at DESC LIMIT 1`,
      )
      .run(flags.feedback ?? null, flags.notes ?? null, gapId);
  }

  console.log('✓ Marked as understood!');
  if (flags.feedback) console.log(`  Feedback: ${flags.feedback}`);
}

interface SessionRow {
  id: string;
  lesson_type: string;
  delivered_at: string;
  delivered_via: string;
  read: number;
  feedback: string | null;
  concept: string | null;
  status: string | null;
}

function cmdHistory(db: Db, flags: Record<string, string>): void {
  const limit = parseInt(flags.limit ?? '20', 10);
  const gapId = flags['gap-id'];

  let sql = `SELECT ls.*, kg.concept, kg.status
    FROM learning_sessions ls
    LEFT JOIN knowledge_gaps kg ON ls.gap_id = kg.id`;
  const params: unknown[] = [];

  if (gapId) {
    sql += ' WHERE ls.gap_id = ?';
    params.push(gapId);
  }

  sql += ' ORDER BY ls.delivered_at DESC LIMIT ?';
  params.push(limit);

  const sessions = db.sqlite.prepare(sql).all(...params) as SessionRow[];

  if (sessions.length === 0) {
    console.log('No learning sessions found.');
    return;
  }

  console.log(`\n📖 Learning History (${sessions.length})\n`);

  sessions.forEach((s, idx) => {
    const readStatus = s.read ? '✓ read' : 'unread';
    console.log(`${idx + 1}. ${s.concept ?? 'Unknown'}`);
    console.log(`   Type: ${s.lesson_type} | Via: ${s.delivered_via} | ${readStatus}`);
    if (s.feedback) console.log(`   Feedback: ${s.feedback}`);
    console.log(`   Delivered: ${s.delivered_at}\n`);
  });
}

// ── Lesson Templates (POC) ────────────────────────────────────────────

function generateLesson(gap: GapRow, lessonType: string): string {
  const paperRef = gap.paper_title
    ? `\n📚 Seen in: ${gap.paper_title}${gap.arxiv_id ? ` (arXiv:${gap.arxiv_id})` : ''}`
    : '';

  if (lessonType === 'eli12') {
    return [
      `# ${gap.concept} — Explained for a Smart 12-Year-Old`,
      '',
      `Imagine [relatable analogy]...`,
      '',
      `[Break down using simple language, concrete examples, and analogies]`,
      '',
      `**Why is this cool?**`,
      `[Explain the impact in terms a young person would find exciting]`,
      '',
      `**Real example:**`,
      `[Show a simple, tangible case where this is used]`,
    ].join('\n');
  }

  if (lessonType === 'deep_dive') {
    return [
      `# Deep Dive: ${gap.concept}`,
      '',
      `## Overview`,
      `[Comprehensive explanation — 1-2 paragraphs]`,
      '',
      `## How It Works`,
      `[Technical details, step-by-step breakdown]`,
      '',
      `## Tradeoffs & Limitations`,
      `- **Pros:** [Key advantages]`,
      `- **Cons:** [Limitations or edge cases]`,
      '',
      `## Real-World Usage`,
      `[Systems/models that implement this]`,
      '',
      `## Related Concepts`,
      `[Prerequisites and related techniques]`,
      paperRef,
    ].join('\n');
  }

  // Default: micro
  return [
    `🎯 ${gap.concept}`,
    '',
    `📖 Quick Context:`,
    `${gap.concept} is a key concept in LLM engineering that addresses [specific problem/goal].`,
    '',
    `The core idea: [2-3 sentence explanation]`,
    '',
    `Think of it like: [concrete analogy or real-world example]`,
    '',
    `Why it matters: [practical impact]`,
    paperRef,
    `🔗 Want deeper dive? Run: tsx src/commands/gap.ts learn ${gap.id} --type deep_dive`,
  ].join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const { positional, flags } = parseArgs(rawArgs);
const command = positional[0];

if (!command) {
  console.log('Usage: tsx src/commands/gap.ts <mark|list|learn|understood|history> [args] [--flags]');
  process.exit(0);
}

const db = getDb();

switch (command) {
  case 'mark':
    if (!positional[1]) {
      console.error('Usage: gap mark <concept> [--paper <arxiv-id>] [--context "..."] [--tags "a,b"]');
      process.exit(1);
    }
    cmdMark(db, positional[1], flags);
    break;
  case 'list':
    cmdList(db, flags);
    break;
  case 'learn':
    if (!positional[1]) {
      console.error('Usage: gap learn <gap-id> [--type micro|deep_dive|eli12]');
      process.exit(1);
    }
    cmdLearn(db, positional[1], flags);
    break;
  case 'understood':
    if (!positional[1]) {
      console.error('Usage: gap understood <gap-id> [--feedback helpful|too_simple|too_complex|want_more]');
      process.exit(1);
    }
    cmdUnderstood(db, positional[1], flags);
    break;
  case 'history':
    cmdHistory(db, flags);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
