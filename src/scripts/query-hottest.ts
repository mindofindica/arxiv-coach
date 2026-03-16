#!/usr/bin/env node
/**
 * query-hottest — /hottest Signal command handler
 *
 * Queries the arxiv-coach paper library for the top-scoring papers
 * discovered in the last N days across all (or a filtered) tracks.
 *
 * Usage:
 *   npm run hottest
 *   npm run hottest -- --days 14
 *   npm run hottest -- --limit 10
 *   npm run hottest -- --track "LLM Agents"
 *   npm run hottest -- --min-score 8
 *   npm run hottest -- --no-dedup
 *   npm run hottest -- --json
 *
 * Options:
 *   --days <n>       Look-back window in days (1–90, default: 7)
 *   --limit <n>      Max papers to return (1–20, default: 5)
 *   --min-score <n>  Minimum match score to include (default: 1)
 *   --track <name>   Filter to a specific track (substring, case-insensitive)
 *   --no-dedup       Show per-(arxiv_id, track) rows instead of unique papers
 *   --json           Output raw JSON instead of Signal-formatted text
 *
 * Output (default):
 *   Signal/Telegram-formatted text listing the top papers.
 *
 * Output (--json):
 *   {
 *     "kind": "hottestResult",
 *     "windowDays": 7,
 *     "limit": 5,
 *     "dedup": true,
 *     "trackFilter": null,
 *     "totalFound": 3,
 *     "reply": "🏆 Top 3 papers — last 7 days\n...",
 *     "papers": [{ arxivId, trackName, score, title, authors, publishedAt, absUrl, matchedTerms }]
 *   }
 *
 * Exit codes:
 *   0  Success (including "no results found")
 *   1  Error (config / DB / bad args)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { getHottestPapers } from '../lib/hottest/hottest.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface Args {
  windowDays: number;
  limit: number;
  minScore: number;
  track: string | null;
  dedup: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let windowDays = 7;
  let limit = 5;
  let minScore = 1;
  let track: string | null = null;
  let dedup = true;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--json' || arg === '-j') {
      json = true;
    } else if (arg === '--no-dedup') {
      dedup = false;
    } else if ((arg === '--days' || arg === '-d') && i + 1 < args.length) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 90) windowDays = n;
    } else if (arg.startsWith('--days=')) {
      const n = parseInt(arg.slice('--days='.length), 10);
      if (!isNaN(n) && n >= 1 && n <= 90) windowDays = n;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < args.length) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if ((arg === '--min-score' || arg === '-m') && i + 1 < args.length) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 1) minScore = n;
    } else if (arg.startsWith('--min-score=')) {
      const n = parseInt(arg.slice('--min-score='.length), 10);
      if (!isNaN(n) && n >= 1) minScore = n;
    } else if ((arg === '--track' || arg === '-t') && i + 1 < args.length) {
      track = args[++i]!;
    } else if (arg.startsWith('--track=')) {
      track = arg.slice('--track='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
query-hottest — Top-scoring papers from your arxiv-coach library

Usage:
  npm run hottest [-- <flags>]

Flags:
  --days <n>       Look-back window in days (1–90, default: 7)
  --limit <n>      Max papers to return (1–20, default: 5)
  --min-score <n>  Minimum match score to include (default: 1)
  --track <name>   Filter to a specific track (substring, case-insensitive)
  --no-dedup       Show per-(paper, track) rows instead of unique papers
  --json           Output raw JSON

Examples:
  npm run hottest
  npm run hottest -- --days 14
  npm run hottest -- --limit 10 --min-score 8
  npm run hottest -- --track "AI Safety"
  npm run hottest -- --no-dedup --json
`);
      process.exit(0);
    }
  }

  return { windowDays, limit, minScore, track, dedup, json };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const result = getHottestPapers(db, {
  windowDays: args.windowDays,
  limit: args.limit,
  minScore: args.minScore,
  track: args.track,
  dedup: args.dedup,
});

if (args.json) {
  console.log(JSON.stringify({
    kind: 'hottestResult',
    windowDays: result.windowDays,
    limit: result.limit,
    dedup: result.dedup,
    trackFilter: result.trackFilter,
    totalFound: result.totalFound,
    reply: result.reply,
    papers: result.papers.map((p) => ({
      arxivId: p.arxivId,
      trackName: p.trackName,
      score: p.score,
      title: p.title,
      authors: p.authors,
      publishedAt: p.publishedAt,
      absUrl: p.absUrl,
      matchedTerms: p.matchedTerms,
    })),
  }));
} else {
  console.log(result.reply);
}
