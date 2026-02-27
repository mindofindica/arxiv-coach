/**
 * query-preview — Digest Preview CLI
 *
 * Runs the same scoring pipeline as the daily digest but does NOT mark
 * anything as sent. Shows what tomorrow's digest would look like right now.
 *
 * Usage:
 *   npm run preview
 *   npm run preview -- --track LLM
 *   npm run preview -- --max-items 5
 *   npm run preview -- --max-per-track 2
 *   npm run preview -- --dedup-days 3
 *   npm run preview -- --json
 *
 * Options:
 *   --track <name>         Only show papers matching this track (substring, case-insensitive)
 *   --max-items <n>        Override maxItemsPerDigest (default: 10)
 *   --max-per-track <n>    Override maxPerTrack (default: 3)
 *   --dedup-days <n>       Override dedup window (default: 7)
 *   --json                 Output raw JSON instead of formatted message
 *
 * Exit codes:
 *   0  — success (even if queue is empty)
 *   1  — unexpected error
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { digestPreview, formatPreviewMessage, formatPreviewSummary } from '../lib/preview/preview.js';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  track: string | undefined;
  maxItems: number;
  maxPerTrack: number;
  dedupDays: number;
  json: boolean;
  summary: boolean;
} {
  const args = argv.slice(2);
  let track: string | undefined;
  let maxItems = 10;
  let maxPerTrack = 3;
  let dedupDays = 7;
  let json = false;
  let summary = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--track' && args[i + 1]) {
      track = args[++i];
    } else if (a === '--max-items' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n > 0) maxItems = n;
    } else if (a === '--max-per-track' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n > 0) maxPerTrack = n;
    } else if (a === '--dedup-days' && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n >= 0) dedupDays = n;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--summary') {
      summary = true;
    }
  }

  return { track, maxItems, maxPerTrack, dedupDays, json, summary };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { track, maxItems, maxPerTrack, dedupDays, json, summary } = parseArgs(process.argv);

  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);

  try {
    const result = digestPreview(db, {
      maxItemsPerDigest: maxItems,
      maxPerTrack,
      dedupDays,
      trackFilter: track,
    });

    if (json) {
      // Serialize Map to object for JSON output
      const out = {
        ...result,
        byTrack: Object.fromEntries(result.byTrack),
      };
      console.log(JSON.stringify(out, null, 2));
    } else if (summary) {
      console.log(formatPreviewSummary(result));
    } else {
      console.log(formatPreviewMessage(result));
    }
  } finally {
    db.sqlite.close();
  }
}

main();
