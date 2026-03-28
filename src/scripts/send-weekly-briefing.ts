/**
 * send-weekly-briefing.ts
 *
 * Build and output the Monday morning personal AI research digest.
 *
 * Called by OpenClaw's cron job every Monday at 09:00 CET.
 * Outputs a JSON result to stdout — OpenClaw reads it and delivers via Signal.
 *
 * Exit codes:
 *   0 — success (or already-sent — idempotent)
 *   1 — fatal error
 *
 * Stdout JSON:
 * {
 *   "status": "sent" | "skipped_already_sent" | "error",
 *   "weekIso": "2026-W13",
 *   "message": "<Signal text>" | null,
 *   "error": "<message>" | null,
 *   "truncated": boolean
 * }
 *
 * Usage:
 *   npm run weekly-briefing
 *   npm run weekly-briefing -- --week=2026-W13   (override week)
 *   npm run weekly-briefing -- --dry-run          (print without marking sent)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureFeedbackTables } from '../lib/feedback/migrate.js';
import {
  buildWeeklyBriefing,
  markBriefingSent,
  ensureBriefingTable,
} from '../lib/briefing/briefing.js';
import { renderWeeklyBriefing } from '../lib/briefing/render-briefing.js';

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  for (const arg of args) {
    const prefix = `--${flag}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

const weekOverride = getArg('week');
const dryRun = args.includes('--dry-run');

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  let config: ReturnType<typeof loadConfig>;

  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify({ status: 'error', weekIso: null, message: null, error: msg, truncated: false }) + '\n',
    );
    process.exit(1);
  }

  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);

  try {
    migrate(db);
    ensureFeedbackTables(db);
    ensureBriefingTable(db);

    const opts = weekOverride ? { weekIso: weekOverride } : {};
    const data = buildWeeklyBriefing(db, opts);

    // Idempotency check
    if (data.alreadySent && !dryRun) {
      process.stdout.write(
        JSON.stringify({
          status: 'skipped_already_sent',
          weekIso: data.weekIso,
          message: null,
          error: null,
          truncated: false,
        }) + '\n',
      );
      process.exit(0);
    }

    const { text, truncated } = renderWeeklyBriefing(data);

    if (!dryRun) {
      markBriefingSent(db, data.weekIso);
    }

    process.stdout.write(
      JSON.stringify({
        status: 'sent',
        weekIso: data.weekIso,
        message: text,
        error: null,
        truncated,
        dryRun,
        stats: {
          currentStreak: data.streak.currentStreak,
          longestStreak: data.streak.longestStreak,
          feedbackTotal: data.feedback.total,
          papersIngested: data.feedback.papersIngested,
          topPapers: data.topPapers.length,
          missedPapers: data.missedPapers.length,
        },
      }) + '\n',
    );
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify({ status: 'error', weekIso: null, message: null, error: msg, truncated: false }) + '\n',
    );
    process.exit(1);
  } finally {
    db.sqlite.close();
  }
}

main();
