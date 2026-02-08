import fs from 'node:fs';

import type { AppConfig } from '../types.js';
import type { Db } from '../db.js';
import { listMatchedPapersMissingArtifacts, updatePdfSha, updateVersionSha } from '../repo.js';
import { downloadToFile } from '../download.js';
import { extractPdfToText, hasPdfToText } from '../extract.js';
import { isPdfFileValid } from '../pdf.js';
import { jitter, sleep } from '../sleep.js';

export interface ArtifactRunOptions {
  config: AppConfig;
  db: Db;
  limit?: number;
  jitterMs?: { min: number; max: number };
}

export interface ArtifactRunResult {
  downloadedPdfs: number;
  extractedTexts: number;
  corruptRedownloads: number;
  skippedNoPdfUrl: number;
}

export async function runArtifacts(opts: ArtifactRunOptions): Promise<ArtifactRunResult> {
  const { config, db, limit = 500, jitterMs = { min: 1100, max: 2950 } } = opts;

  const pdfToTextOk = hasPdfToText();
  if (!pdfToTextOk) {
    console.warn('pdftotext is not installed. Skipping PDF text extraction.');
  }

  const matched = listMatchedPapersMissingArtifacts(db, limit);

  let downloadedPdfs = 0;
  let extractedTexts = 0;
  let corruptRedownloads = 0;
  let skippedNoPdfUrl = 0;

  for (const p of matched) {
    const pdfExists = fs.existsSync(p.pdf_path);
    const pdfValid = pdfExists ? isPdfFileValid(p.pdf_path) : false;
    const needsPdf = !pdfExists || !pdfValid;
    const needsTxt = !fs.existsSync(p.txt_path);

    if (!needsPdf && (!needsTxt || !pdfToTextOk)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(p.meta_path, 'utf8')) as { pdfUrl?: string; version?: string };
      const pdfUrl = meta.pdfUrl ?? null;
      const version = meta.version ?? null;

      if (needsPdf) {
        if (pdfExists && !pdfValid) {
          corruptRedownloads += 1;
          try { fs.rmSync(p.pdf_path, { force: true }); } catch {}
        }

        if (!pdfUrl) {
          skippedNoPdfUrl += 1;
        } else {
          await sleep(jitter(jitterMs.min, jitterMs.max));
          const res = await downloadToFile(pdfUrl, p.pdf_path);
          updatePdfSha(db, p.arxiv_id, res.sha256);
          if (version) updateVersionSha(db, p.arxiv_id, version, res.sha256);
          downloadedPdfs += 1;
        }
      }

      if (pdfToTextOk && fs.existsSync(p.pdf_path) && needsTxt) {
        extractPdfToText(p.pdf_path, p.txt_path);
        extractedTexts += 1;
      }
    } catch (e) {
      console.warn(`Artifact step failed for ${p.arxiv_id}: ${String((e as any)?.message ?? e)}`);
    }
  }

  return { downloadedPdfs, extractedTexts, corruptRedownloads, skippedNoPdfUrl };
}
