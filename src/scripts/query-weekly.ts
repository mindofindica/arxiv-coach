/**
 * query-weekly — /weekly Signal command handler
 *
 * Usage:
 *   npm run query-weekly                        # Current ISO week
 *   npm run query-weekly -- --week 2026-W07     # Specific week
 *   npm run query-weekly -- --json              # Output raw JSON (default: Signal text)
 *   npm run query-weekly -- --week 2026-W07 --json
 *
 * Output modes:
 *   (default)  Signal-formatted text, ready to send via openclaw
 *   --json     Machine-readable JSON for further processing
 *
 * Exit codes:
 *   0  Success
 *   1  Error (config / DB / invalid args)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { isoWeek } from '../lib/weekly/select.js';
import { getWeeklySummary } from '../lib/query/weekly-summary.js';
import { renderWeeklySummaryMessage } from '../lib/query/render-weekly-summary.js';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

interface Args {
  weekIso: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let weekIso: string | null = null;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === '--week' || arg === '-w') && i + 1 < argv.length) {
      weekIso = argv[++i]!;
    } else if (arg.startsWith('--week=')) {
      weekIso = arg.slice('--week='.length);
    } else if (arg === '--json' || arg === '-j') {
      json = true;
    }
  }

  // Default to current ISO week if not specified
  if (!weekIso) {
    weekIso = isoWeek(new Date());
  }

  // Basic format validation
  if (!/^\d{4}-W\d{2}$/.test(weekIso)) {
    console.error(`Error: Invalid week format "${weekIso}" — expected YYYY-Www (e.g. 2026-W08)`);
    process.exit(1);
  }

  return { weekIso, json };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { weekIso, json } = parseArgs(process.argv.slice(2));

  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);

  const summary = getWeeklySummary(db, weekIso, { maxTopPapers: 5 });

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const { text } = renderWeeklySummaryMessage(summary);
    console.log(text);
  }
}

main().catch(err => {
  console.error('query-weekly error:', err);
  process.exit(1);
});
