/**
 * Backfill digest_papers table from sent_digests + digest markdown files.
 *
 * The old markDigestSent() only wrote to sent_digests (no per-paper rows).
 * This script parses the daily digest .md files to extract arxiv IDs
 * and backfills digest_papers for all dates that have a sent_digests row.
 *
 * Safe to run multiple times (uses INSERT OR IGNORE).
 *
 * Usage:
 *   npm run backfill-digest-papers
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDb, migrate } from '../lib/db.js';
import { loadConfig } from '../lib/config.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const digestDir = path.join(config.storage.root, 'digests', 'daily');

// Get all dates with sent_digests rows (daily kind only)
interface SentDigestRow { digest_date: string; sent_at: string }
const sentDates = db.sqlite
  .prepare("SELECT digest_date, sent_at FROM sent_digests WHERE kind='daily' ORDER BY digest_date")
  .all() as SentDigestRow[];

console.log(`Found ${sentDates.length} sent daily digests to backfill.`);

// Check what's already in digest_papers
const alreadyBackfilled = new Set<string>();
const existing = db.sqlite
  .prepare('SELECT DISTINCT digest_date FROM digest_papers')
  .all() as { digest_date: string }[];
for (const r of existing) alreadyBackfilled.add(r.digest_date);

const insertPaper = db.sqlite.prepare(
  `INSERT OR IGNORE INTO digest_papers (arxiv_id, digest_date, track_name, sent_at)
   VALUES (?, ?, ?, ?)`
);

// The sent_digests.tracks_json messages contain paper titles but not arxiv IDs.
// We extract paper titles from the message format:
//   • <Paper Title>\n  relevance: ...
// Then look up arxiv IDs from the papers table by exact title match.

interface TracksRow { digest_date: string; tracks_json: string; sent_at: string }
const allSentDigests = db.sqlite
  .prepare("SELECT digest_date, tracks_json, sent_at FROM sent_digests WHERE kind='daily'")
  .all() as TracksRow[];

// Build title→arxiv_id lookup from papers table
interface PaperRow { arxiv_id: string; title: string }
const allPapers = db.sqlite.prepare('SELECT arxiv_id, title FROM papers').all() as PaperRow[];
const titleToArxivId = new Map<string, string>();
for (const p of allPapers) {
  titleToArxivId.set(p.title.trim().toLowerCase(), p.arxiv_id);
}
console.log(`  Loaded ${titleToArxivId.size} papers into title lookup.`);

// Regex to extract paper titles from message format: "• <title>\n  relevance..."
const PAPER_TITLE_RE = /^[•·]\s+\*?\*?(.+?)\*?\*?$/gm;

let totalInserted = 0;
let totalSkipped = 0;

const tx = db.sqlite.transaction(() => {
  for (const row of allSentDigests) {
    if (alreadyBackfilled.has(row.digest_date)) {
      console.log(`  ${row.digest_date}: already backfilled, skipping.`);
      totalSkipped++;
      continue;
    }

    const tracks = JSON.parse(row.tracks_json) as Array<{ track: string; message: string }>;
    let inserted = 0;
    let missed = 0;

    for (const t of tracks) {
      // Extract paper titles from the bullet-point format
      PAPER_TITLE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PAPER_TITLE_RE.exec(t.message)) !== null) {
        const rawTitle = m[1]!.trim();
        const arxivId = titleToArxivId.get(rawTitle.toLowerCase());

        if (!arxivId) {
          // Try partial match (first 60 chars) since titles might be truncated
          let found = false;
          if (rawTitle.length > 40) {
            const prefix = rawTitle.slice(0, 60).toLowerCase();
            for (const [title, id] of titleToArxivId) {
              if (title.startsWith(prefix) || title.includes(prefix.slice(0, 40))) {
                insertPaper.run(id, row.digest_date, t.track, row.sent_at);
                inserted++;
                found = true;
                break;
              }
            }
          }
          if (!found) missed++;
          continue;
        }

        insertPaper.run(arxivId, row.digest_date, t.track, row.sent_at);
        inserted++;
      }
    }

    console.log(`  ${row.digest_date}: inserted ${inserted} paper rows (missed: ${missed}, tracks: ${tracks.length}).`);
    totalInserted += inserted;
  }
});

tx();

const finalCount = db.sqlite.prepare('SELECT COUNT(*) as n FROM digest_papers').get() as { n: number };
console.log(`\nBackfill complete.`);
console.log(`  Total inserted: ${totalInserted}`);
console.log(`  Already had rows: ${totalSkipped}`);
console.log(`  digest_papers total rows: ${finalCount.n}`);
