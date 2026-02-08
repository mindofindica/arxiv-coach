import fs from 'node:fs';
import path from 'node:path';

import type { AppConfig, TracksFile } from '../types.js';
import { openDb, migrate, type Db } from '../db.js';
import { ensureStorageRoot, listMatchedPapersMissingArtifacts, updatePdfSha, updateVersionSha, upsertPaper, upsertTrackMatch } from '../repo.js';
import { fetchAtom, parseAtom, withinLastDays } from '../arxiv.js';
import { matchTrack } from '../match.js';
import { paperPaths } from '../storage.js';
import { downloadToFile } from '../download.js';
import { extractPdfToText, hasPdfToText } from '../extract.js';
import { jitter, sleep } from '../sleep.js';

export interface DailyRunOptions {
  config: AppConfig;
  tracksFile: TracksFile;
  now?: Date;
  dbPath?: string; // default: <storage.root>/db.sqlite
  daysWindow?: number; // default 3
  fetchMaxResults?: number; // default 100
  politenessJitterMs?: { min: number; max: number }; // default 1100..2950
}

export interface DailyRunResult {
  runId: string;
  status: 'ok' | 'warn' | 'error';
  stats: any;
}

function insertRun(db: Db, runId: string, startedAt: string) {
  db.sqlite.prepare(
    `INSERT INTO runs (run_id, kind, started_at, finished_at, status, stats_json)
     VALUES (?, 'daily', ?, NULL, 'running', ?)`
  ).run(runId, startedAt, JSON.stringify({}));
}

function finalizeRun(db: Db, runId: string, status: string, stats: any) {
  db.sqlite.prepare('UPDATE runs SET finished_at=?, status=?, stats_json=? WHERE run_id=?')
    .run(new Date().toISOString(), status, JSON.stringify(stats), runId);
}

export async function runDaily(opts: DailyRunOptions): Promise<DailyRunResult> {
  const {
    config,
    tracksFile,
    now = new Date(),
    dbPath = path.join(config.storage.root, 'db.sqlite'),
    daysWindow = 3,
    fetchMaxResults = 100,
    politenessJitterMs = { min: 1100, max: 2950 },
  } = opts;

  ensureStorageRoot(config);

  const db = openDb(dbPath);
  migrate(db);

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const enabledTracks = tracksFile.tracks.filter((t) => t.enabled);

  const stats: any = {
    categories: config.discovery.categories,
    fetchedEntries: 0,
    keptEntries: 0,
    upsertedPapers: 0,
    trackMatches: 0,
    discoveryErrors: [],
    downloadedPdfs: 0,
    extractedTexts: 0,
    startedAt,
  };

  insertRun(db, runId, startedAt);

  try {
    // --- Step 2: discovery + matching ---
    for (const cat of config.discovery.categories) {
      await sleep(jitter(politenessJitterMs.min, politenessJitterMs.max));

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
          // ignore meta write errors for now
        }
      }
    }

    // --- Step 3: artifacts (matched only) ---
    const pdfToTextOk = hasPdfToText();
    if (!pdfToTextOk) {
      console.warn('pdftotext is not installed. Skipping PDF text extraction for now.');
    }

    const matched = listMatchedPapersMissingArtifacts(db, 500);

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
            await sleep(jitter(politenessJitterMs.min, politenessJitterMs.max));
            const res = await downloadToFile(pdfUrl, p.pdf_path);
            updatePdfSha(db, p.arxiv_id, res.sha256);
            if (version) updateVersionSha(db, p.arxiv_id, version, res.sha256);
            stats.downloadedPdfs += 1;
          }
        }

        if (pdfToTextOk && fs.existsSync(p.pdf_path) && needsTxt) {
          extractPdfToText(p.pdf_path, p.txt_path);
          stats.extractedTexts += 1;
        }
      } catch (e) {
        console.warn(`Artifact step failed for ${p.arxiv_id}: ${String((e as any)?.message ?? e)}`);
      }
    }

    const status: DailyRunResult['status'] = stats.discoveryErrors.length > 0 ? 'warn' : 'ok';
    finalizeRun(db, runId, status, stats);

    return { runId, status, stats };
  } catch (e) {
    finalizeRun(db, runId, 'error', { ...stats, error: String((e as any)?.message ?? e) });
    throw e;
  }
}
