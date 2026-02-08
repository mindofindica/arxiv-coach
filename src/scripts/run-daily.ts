import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadTracks } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureStorageRoot, upsertPaper, upsertTrackMatch, listMatchedPapersMissingArtifacts, updatePdfSha, updateVersionSha } from '../lib/repo.js';
import { fetchAtom, parseAtom, withinLastDays } from '../lib/arxiv.js';
import { matchTrack } from '../lib/match.js';
import { paperPaths } from '../lib/storage.js';
import { downloadToFile } from '../lib/download.js';
import { extractPdfToText, hasPdfToText } from '../lib/extract.js';
import { jitter, sleep } from '../lib/sleep.js';

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

const stats: any = {
  categories: config.discovery.categories,
  fetchedEntries: 0,
  keptEntries: 0,
  upsertedPapers: 0,
  trackMatches: 0,
  discoveryErrors: [],
  startedAt,
};

try {
  for (const cat of config.discovery.categories) {
    // Politeness delay between category fetches (separate from PDF download jitter)
    await sleep(jitter(1100, 2950));

    let xml: string;
    try {
      xml = await fetchAtom(cat, 100);
    } catch (e) {
      // If arXiv is rate limiting (429), we still want the run to succeed so we can
      // process any already-matched backlog in the artifact step.
      const msg = String((e as any)?.message ?? e);
      console.warn(`Discovery fetch failed for ${cat}: ${msg}`);
      stats.discoveryErrors.push({ category: cat, error: msg });
      continue;
    }

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

        // Default behavior: if a paper meets the score threshold, we match it.
        // In most cases matchedTerms will be non-empty, but we don't require it
        // so we can still record borderline/edge cases and tune later.
        if (m.score >= track.threshold) {
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

  // --- Step 3: download PDFs + extract text for matched papers only ---
  const pdfToTextOk = hasPdfToText();
  if (!pdfToTextOk) {
    console.warn('pdftotext is not installed. Skipping PDF text extraction for now.');
  }

  const matched = listMatchedPapersMissingArtifacts(db, 200);
  let downloaded = 0;
  let extracted = 0;

  for (const p of matched) {
    const needsPdf = !fs.existsSync(p.pdf_path);
    const needsTxt = !fs.existsSync(p.txt_path);

    if (!needsPdf && (!needsTxt || !pdfToTextOk)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(p.meta_path, 'utf8')) as { pdfUrl?: string; version?: string };
      const pdfUrl = meta.pdfUrl ?? null;
      const version = meta.version ?? null;

      if (needsPdf) {
        if (!pdfUrl) {
          console.warn(`No pdfUrl for ${p.arxiv_id}, skipping download`);
        } else {
          // Conservative jitter for arXiv friendliness
          const waitMs = jitter(1100, 2950);
          await sleep(waitMs);
          const res = await downloadToFile(pdfUrl, p.pdf_path);
          updatePdfSha(db, p.arxiv_id, res.sha256);
          if (version) updateVersionSha(db, p.arxiv_id, version, res.sha256);
          downloaded += 1;
        }
      }

      if (pdfToTextOk && fs.existsSync(p.pdf_path) && needsTxt) {
        extractPdfToText(p.pdf_path, p.txt_path);
        extracted += 1;
      }
    } catch (e) {
      console.warn(`Artifact step failed for ${p.arxiv_id}: ${String((e as any)?.message ?? e)}`);
    }
  }

  (stats as any).downloadedPdfs = downloaded;
  (stats as any).extractedTexts = extracted;

  const finishedAt = new Date().toISOString();
  const status = stats.discoveryErrors.length > 0 ? 'warn' : 'ok';

  db.sqlite.prepare('UPDATE runs SET finished_at=?, status=?, stats_json=? WHERE run_id=?')
    .run(finishedAt, status, JSON.stringify(stats), runId);

  if (status === 'warn') {
    console.warn(`Daily completed with discovery warnings (${stats.discoveryErrors.length}). See runs.stats_json for details.`);
  }

  console.log(`Daily OK. Papers upserted: ${stats.upsertedPapers}. Track matches: ${stats.trackMatches}. PDFs: ${downloaded}, txt: ${extracted}`);
} catch (err: any) {
  db.sqlite.prepare('UPDATE runs SET finished_at=?, status=?, stats_json=? WHERE run_id=?')
    .run(new Date().toISOString(), 'error', JSON.stringify({ ...stats, error: String(err?.message ?? err) }), runId);
  throw err;
}
