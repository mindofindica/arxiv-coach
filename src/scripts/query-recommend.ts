/**
 * query-recommend — /recommend Signal command handler
 *
 * Generates personalised paper recommendations based on the user's
 * positive feedback history (loved + saved + high-priority reading list).
 *
 * Usage:
 *   npm run recommend
 *   npm run recommend -- --limit 10
 *   npm run recommend -- --track LLM
 *   npm run recommend -- --json
 *
 * Options:
 *   --limit <n>    Max recommendations to return (1–20, default 5)
 *   --track <name> Filter recommendations to a specific track
 *   --json         Output raw JSON instead of Signal-formatted text
 *
 * Output modes:
 *   (default)  Signal-formatted text, ready to paste into Signal
 *   --json     Machine-readable JSON for further processing
 *
 * Exit codes:
 *   0  Success (including "no results" / "not enough data")
 *   1  Error (config / DB problem)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureFeedbackTables } from '../lib/feedback/migrate.js';
import { recommendPapers, formatRecommendReply } from '../lib/recommend/recommend.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface Args {
  limit: number;
  track: string | undefined;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let limit = 5;
  let track: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--json' || arg === '-j') {
      json = true;
    } else if ((arg === '--limit' || arg === '-l') && i + 1 < argv.length) {
      const n = parseInt(argv[++i]!, 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!isNaN(n) && n >= 1 && n <= 20) limit = n;
    } else if ((arg === '--track' || arg === '-t') && i + 1 < argv.length) {
      track = argv[++i]!;
    } else if (arg.startsWith('--track=')) {
      track = arg.slice('--track='.length);
    }
  }

  return { limit, track, json };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { limit, track, json } = parseArgs(process.argv.slice(2));

  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);
  ensureFeedbackTables(db);

  const resp = recommendPapers(db, { limit, track });

  db.sqlite.close();

  if (json) {
    console.log(JSON.stringify(resp, null, 2));
  } else {
    console.log(formatRecommendReply(resp));
  }
}

main().catch(err => {
  console.error('query-recommend error:', err);
  process.exit(1);
});
