import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadTracks } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch } from '../lib/repo.js';
import { fetchAtom, parseAtom, withinLastDays } from '../lib/arxiv.js';
import { matchTrack } from '../lib/match.js';
import { paperPaths } from '../lib/storage.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const tracksFile = loadTracks(repoRoot);
const enabledTracks = tracksFile.tracks.filter((t) => t.enabled);

ensureStorageRoot(config);

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

const runId = crypto.randomUUID();
const startedAt = new Date().toISOString();

db.sqlite.prepare(
  `INSERT INTO runs (run_id, kind, started_at, finished_at, status, stats_json)
   VALUES (?, 'daily', ?, NULL, 'running', ?)`
).run(runId, startedAt, JSON.stringify({}));

const now = new Date();
const DAYS = 3;

const stats = {
  categories: config.discovery.categories,
  fetchedEntries: 0,
  keptEntries: 0,
  upsertedPapers: 0,
  trackMatches: 0,
  startedAt,
};

try {
  for (const cat of config.discovery.categories) {
    const xml = await fetchAtom(cat, 200);
    const entries = parseAtom(xml);
    stats.fetchedEntries += entries.length;

    // keep last 3 days by updatedAt (fallback to publishedAt)
    const recent = entries.filter((e) => withinLastDays(e.updatedAt || e.publishedAt, DAYS, now));
    stats.keptEntries += recent.length;

    for (const entry of recent) {
      upsertPaper(db, config, entry);
      stats.upsertedPapers += 1;

      for (const track of enabledTracks) {
        // Optional: category gating per track
        if (track.categories?.length) {
          const ok = entry.categories.some((c) => track.categories.includes(c));
          if (!ok) continue;
        }

        const m = matchTrack(track, entry.title, entry.summary);
        if (m.score >= track.threshold && m.matchedTerms.length > 0) {
          upsertTrackMatch(db, entry.arxivId, track.name, m.score, m.matchedTerms);
          stats.trackMatches += 1;
        }
      }

      // store minimal meta.json now (full raw can be added later)
      try {
        const { metaPath, paperDir } = paperPaths(
          config.storage.root,
          entry.arxivId,
          new Date(entry.updatedAt)
        );
        fs.mkdirSync(paperDir, { recursive: true });
        fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));
      } catch {
        // ignore meta write errors for now
      }
    }
  }

  db.sqlite.prepare('UPDATE runs SET finished_at=?, status=?, stats_json=? WHERE run_id=?')
    .run(new Date().toISOString(), 'ok', JSON.stringify(stats), runId);

  console.log(`Daily discovery OK. Papers upserted: ${stats.upsertedPapers}. Track matches: ${stats.trackMatches}`);
} catch (err: any) {
  db.sqlite.prepare('UPDATE runs SET finished_at=?, status=?, stats_json=? WHERE run_id=?')
    .run(new Date().toISOString(), 'error', JSON.stringify({ ...stats, error: String(err?.message ?? err) }), runId);
  throw err;
}
