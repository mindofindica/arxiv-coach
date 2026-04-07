/**
 * check-hot-papers.ts
 *
 * Find papers in track_matches that scored above the hot-paper threshold
 * but haven't been alerted yet. Marks them as alerted and outputs a JSON
 * plan that the OpenClaw cron reads to deliver Signal/Telegram messages.
 *
 * Output JSON (stdout):
 *   {
 *     "kind": "hotAlertPlan",
 *     "totalFound": N,
 *     "threshold": N,
 *     "messages": ["🔥 Hot paper in ..."],   // one per paper (+ optional batch header)
 *     "papers": [{ arxivId, trackName, score, title }]
 *   }
 *
 * If no hot papers found: totalFound=0, messages=[], papers=[]
 *
 * Usage: npm run check-hot-papers
 * Optional env overrides:
 *   HOT_THRESHOLD=8   — minimum score to qualify (default: 8)
 *   HOT_WINDOW_DAYS=3 — only check papers discovered in last N days (default: 3)
 *   HOT_MAX=5         — max papers to alert per run (default: 5)
 */

import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { processHotAlerts } from '../lib/alerts/hot-paper.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const threshold = parseInt(process.env.HOT_THRESHOLD ?? '8', 10);
const windowDays = parseInt(process.env.HOT_WINDOW_DAYS ?? '3', 10);
const maxPerRun = parseInt(process.env.HOT_MAX ?? '5', 10);

const result = processHotAlerts(db, { threshold, windowDays, maxPerRun });

console.log(JSON.stringify({
  kind: 'hotAlertPlan',
  totalFound: result.totalFound,
  threshold,
  messages: result.messages,
  papers: result.papers.map((p) => ({
    arxivId: p.arxivId,
    trackName: p.trackName,
    score: p.score,
    title: p.title,
  })),
}));
