#!/usr/bin/env node
/**
 * CLI entry point for the /explain command
 *
 * Usage:
 *   npm run explain -- <arxiv-id or title keywords or "#2 from today"> [--level eli12|undergrad|engineer]
 *
 * Examples:
 *   npm run explain -- 2402.01234
 *   npm run explain -- 2402.01234 --level eli12
 *   npm run explain -- "attention is all you need"
 *   npm run explain -- "#1 from today" --level undergrad
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import { ensureFeedbackTables } from '../lib/feedback/migrate.js';
import { explainPaper, formatExplainReply } from '../lib/explain/explainPaper.js';
import type { ExplainLevel } from '../lib/explain/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../');

// ── Parse CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage: npm run explain -- <query> [--level eli12|undergrad|engineer]

Where <query> is one of:
  2402.01234                      — arxiv ID
  arxiv:2402.01234                — prefixed arxiv ID
  "attention is all you need"     — title keywords
  "#2 from today"                 — digest reference
  "#1 from 2026-03-20"            — digest reference with date

Options:
  --level eli12       Explain like I'm 12
  --level undergrad   Explain to a CS undergrad
  --level engineer    Explain to a senior ML engineer (default)
`);
  process.exit(0);
}

// Split positional query from flags
const levelFlagIdx = args.findIndex(a => a === '--level');
let level: ExplainLevel = 'engineer';
const filteredArgs = [...args];

if (levelFlagIdx !== -1) {
  const levelVal = args[levelFlagIdx + 1];
  if (levelVal === 'eli12' || levelVal === 'undergrad' || levelVal === 'engineer') {
    level = levelVal;
    filteredArgs.splice(levelFlagIdx, 2);
  } else {
    console.error(`Invalid --level value: ${levelVal ?? '(missing)'}`);
    console.error('Valid values: eli12, undergrad, engineer');
    process.exit(1);
  }
}

const query = filteredArgs.join(' ').trim();

if (!query) {
  console.error('Error: no query provided');
  process.exit(1);
}

// ── Run ────────────────────────────────────────────────────────────────────

const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);
ensureFeedbackTables(db);

console.log(`🔍 Explaining: "${query}" [level: ${level}]\n`);

const result = await explainPaper({ db, query, level, repoRoot });

if (!result.ok) {
  console.error(result.message);
  if (result.error === 'ambiguous') {
    console.error('\nCandidates:');
    for (const c of result.candidates) {
      console.error(`  ${c.arxivId} — ${c.title}`);
    }
  }
  db.sqlite.close();
  process.exit(1);
}

console.log(formatExplainReply(result));
console.log(`\n[Source: ${result.contextSource}]`);

db.sqlite.close();
