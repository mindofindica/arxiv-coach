#!/usr/bin/env node
/**
 * hottest.ts — CLI for the /hottest command
 *
 * Surfaces the top-scoring papers from the last N days across all tracks,
 * deduplicated by arxiv_id (a paper matching 3 tracks only appears once,
 * scored by its highest track score).
 *
 * Usage:
 *   npm run hottest
 *   npm run hottest -- --days 14
 *   npm run hottest -- --track rag
 *   npm run hottest -- --limit 10
 *   npm run hottest -- --min-score 8
 *   npm run hottest -- --json
 *
 * Flags:
 *   --days N        Look-back window in days (default: 7, max: 90)
 *   --track NAME    Filter to a specific track (case-insensitive substring)
 *   --limit N       Max results to show (default: 5, max: 20)
 *   --min-score N   Minimum score threshold (default: 1)
 *   --json          Output raw JSON instead of formatted text
 *
 * Score icons:
 *   🌟 ≥10  — exceptional
 *   ⭐ ≥8   — very strong
 *   ✨  <8   — notable
 */

import path from 'node:path';
import { openDb, migrate } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';
import { queryHottestPapers, formatHottest } from '../lib/query/hottest-papers.js';

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  days: number;
  track: string | null;
  limit: number;
  minScore: number;
  json: boolean;
} {
  const args = argv.slice(2);
  let days = 7;
  let track: string | null = null;
  let limit = 5;
  let minScore = 1;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--days' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n)) days = n;
    } else if (arg === '--track' && args[i + 1]) {
      track = args[++i]!;
    } else if (arg === '--limit' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n)) limit = n;
    } else if (arg === '--min-score' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n)) minScore = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
hottest — Surface top-scoring papers from the last N days

Usage:
  npm run hottest [-- <flags>]

Flags:
  --days N        Look-back window in days (default: 7, max: 90)
  --track NAME    Filter to a specific track (case-insensitive substring)
  --limit N       Max results to show (default: 5, max: 20)
  --min-score N   Minimum score threshold (default: 1)
  --json          Output raw JSON instead of formatted text

Examples:
  npm run hottest
  npm run hottest -- --days 14
  npm run hottest -- --track rag
  npm run hottest -- --track "agent evaluation" --limit 10
  npm run hottest -- --min-score 8
  npm run hottest -- --json
`);
      process.exit(0);
    }
  }

  return { days, track, limit, minScore, json };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { days, track, limit, minScore, json } = parseArgs(process.argv);

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');

  const db = openDb(dbPath);
  migrate(db);

  const result = queryHottestPapers(db, { days, track, limit, minScore });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHottest(result));
    console.log();
    if (result.kind === 'hottest') {
      const note = result.totalFound > result.papers.length
        ? ` (${result.totalFound - result.papers.length} more — use --limit to see more)`
        : '';
      console.log(
        `\nWindow: last ${result.days} day${result.days === 1 ? '' : 's'}` +
        (result.track ? ` · track filter: ${result.track}` : '') +
        note
      );
    }
  }

  db.sqlite.close();
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
