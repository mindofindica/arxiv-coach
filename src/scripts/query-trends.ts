#!/usr/bin/env node
/**
 * query-trends — CLI for the /trends analysis
 *
 * Usage:
 *   npm run trends
 *   npm run trends -- --weeks 4
 *   npm run trends -- --weeks 12 --min-appearances 3
 *   npm run trends -- --limit 15 --threshold 20
 *   npm run trends -- --json
 *
 * Flags:
 *   --weeks N         Look-back window in weeks (default: 8, max: 52)
 *   --min-appearances N  Min weighted appearances to include a keyword (default: 2)
 *   --threshold N     % change needed to call rising/falling (default: 30)
 *   --limit N         Max keywords per category (default: 10)
 *   --json            Output raw JSON instead of formatted text
 */

import path from 'node:path';
import { openDb, migrate } from '../lib/db.js';
import { ensureFeedbackTables } from '../lib/feedback/migrate.js';
import { loadConfig } from '../lib/config.js';
import { analyseTrends, formatTrendsReply } from '../lib/trends/trends.js';

// ── Arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  weeks: number;
  minAppearances: number;
  threshold: number;
  limit: number;
  json: boolean;
} {
  const args = argv.slice(2);
  let weeks = 8;
  let minAppearances = 2;
  let threshold = 30;
  let limit = 10;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--weeks' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 52) weeks = n;
    } else if (arg === '--min-appearances' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1) minAppearances = n;
    } else if (arg === '--threshold' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 100) threshold = n;
    } else if (arg === '--limit' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 50) limit = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
query-trends — Analyse keyword trends in your paper feedback history

Usage:
  npm run trends [-- <flags>]

Flags:
  --weeks N            Look-back window in weeks (default: 8, max: 52)
  --min-appearances N  Min weighted appearances to include a keyword (default: 2)
  --threshold N        % change to classify as rising/falling (default: 30)
  --limit N            Max keywords per category (default: 10)
  --json               Output raw JSON

Examples:
  npm run trends
  npm run trends -- --weeks 4
  npm run trends -- --weeks 12 --min-appearances 3 --limit 15
  npm run trends -- --json
`);
      process.exit(0);
    }
  }

  return { weeks, minAppearances, threshold, limit, json };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { weeks, minAppearances, threshold, limit, json } = parseArgs(process.argv);

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');

  const db = openDb(dbPath);
  migrate(db);
  ensureFeedbackTables(db);

  const result = analyseTrends(db, {
    weeks,
    minAppearances,
    thresholdPct: threshold,
    limit,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatTrendsReply(result));
    console.log();
    if (result.uniqueKeywords > 0) {
      console.log(`(${result.uniqueKeywords} unique keywords found before limit/threshold filters)`);
    }
  }

  db.sqlite.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
