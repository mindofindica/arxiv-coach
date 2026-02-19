/**
 * plan-daily-fast.ts
 *
 * Like plan-daily.ts but skips artifact downloads (Step 3).
 * Used when the full plan-daily is killed due to memory/time limits.
 *
 * Steps:
 *   1. Fetch arXiv Atom feeds and upsert papers
 *   2. Match papers against tracks
 *   3. SKIP artifact downloads
 *   4. Select + render digest
 *   5. Emit JSON to stdout (same format as plan-daily)
 */

import path from 'node:path';
import fs from 'node:fs';

import { loadConfig, loadTracks } from '../lib/config.js';
import { openDb, migrate, type Db } from '../lib/db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch } from '../lib/repo.js';
import { selectDailyByTrack } from '../lib/digest/select.js';
import { renderDailyMarkdown, renderHeaderSignalMessage, renderTrackSignalMessage } from '../lib/digest/render.js';
import { ensureDir, dailyDigestPath, paperPaths } from '../lib/storage.js';
import { hasDigestBeenSent } from '../lib/notify/plan.js';
import { fetchAtom, parseAtom, withinLastDays } from '../lib/arxiv.js';
import { matchTrack } from '../lib/match.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const tracksFile = loadTracks(repoRoot);

const now = new Date();
const daysWindow = 3;
const fetchMaxResults = 100;

function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

ensureStorageRoot(config);

const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const stats: any = {
  categories: config.discovery.categories,
  fetchedEntries: 0,
  keptEntries: 0,
  upsertedPapers: 0,
  trackMatches: 0,
  discoveryErrors: [],
  skippedArtifacts: true,
};

const enabledTracks = tracksFile.tracks.filter((t) => t.enabled);

// Step 1+2: Fetch + match
for (const cat of config.discovery.categories) {
  let xml: string;
  try {
    xml = await fetchAtom(cat, fetchMaxResults);
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    console.warn(`Discovery fetch failed for ${cat}: ${msg}`);
    stats.discoveryErrors.push({ category: cat, error: msg });
    continue;
  }

  const entries = parseAtom(xml);
  stats.fetchedEntries += entries.length;

  const recent = entries.filter((e) => withinLastDays(e.updatedAt || e.publishedAt, daysWindow, now));
  stats.keptEntries += recent.length;

  for (const entry of recent) {
    upsertPaper(db, config, entry);
    stats.upsertedPapers += 1;

    for (const track of enabledTracks) {
      if (track.categories?.length) {
        const ok = entry.categories.some((c) => track.categories.includes(c));
        if (!ok) continue;
      }

      const m = matchTrack(track, entry.title, entry.summary);
      if (m.score >= track.threshold) {
        upsertTrackMatch(db, entry.arxivId, track.name, m.score, m.matchedTerms);
        stats.trackMatches += 1;
      }
    }

    // Write minimal meta.json
    try {
      const { metaPath, paperDir } = paperPaths(config.storage.root, entry.arxivId, new Date(entry.updatedAt));
      fs.mkdirSync(paperDir, { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2));
    } catch {
      // ignore
    }
  }
}

// Step 3: SKIPPED (artifact downloads)

// Step 4: Select + render
const selection = selectDailyByTrack(db, {
  maxItemsPerDigest: config.limits.maxItemsPerDigest,
  maxPerTrack: config.limits.maxPerTrackPerDay,
});

const dateIso = isoDate(now);
const md = renderDailyMarkdown(dateIso, selection.byTrack);
const digestPath = dailyDigestPath(config.storage.root, now);
ensureDir(path.dirname(digestPath));
fs.writeFileSync(digestPath, md);

const header = renderHeaderSignalMessage(dateIso, selection.byTrack);
const perTrack = Array.from(selection.byTrack.entries()).map(([track, papers]) => ({
  track,
  ...renderTrackSignalMessage(track, papers),
}));

const alreadySent = hasDigestBeenSent(db, dateIso);

// Build flat paper list for digest_papers dedup tracking
const digestPapers: Array<{ arxivId: string; trackName: string }> = [];
for (const [trackName, papers] of selection.byTrack.entries()) {
  for (const p of papers) {
    digestPapers.push({ arxivId: p.arxivId, trackName });
  }
}

const digestPlan = {
  dateIso,
  digestPath,
  header: header.text,
  tracks: perTrack.map((m) => ({ track: m.track, message: m.text })),
  papers: digestPapers,
  alreadySent,
  items: selection.totals.items,
  tracksWithItems: selection.totals.tracksWithItems,
};

stats.digestPlan = digestPlan;

const status = stats.discoveryErrors.length > 0 ? 'warn' : 'ok';

console.log(JSON.stringify({
  kind: 'dailyPlan',
  status,
  discoveryErrors: stats.discoveryErrors,
  digestPlan,
}));
