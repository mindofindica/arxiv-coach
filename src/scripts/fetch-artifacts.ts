// Step 3 runner: download PDFs + extract text for matched papers only.
// Useful when arXiv API is rate-limiting (429) and we still want to process backlog.

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureStorageRoot, listMatchedPapersMissingArtifacts, updatePdfSha, updateVersionSha } from '../lib/repo.js';
import { downloadToFile } from '../lib/download.js';
import { extractPdfToText, hasPdfToText } from '../lib/extract.js';
import { jitter, sleep } from '../lib/sleep.js';
import { isPdfFileValid } from '../lib/pdf.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

ensureStorageRoot(config);

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

const pdfToTextOk = hasPdfToText();
if (!pdfToTextOk) {
  console.warn('pdftotext is not installed. Skipping PDF text extraction.');
}

const matched = listMatchedPapersMissingArtifacts(db, 500);
let downloaded = 0;
let extracted = 0;

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
        console.warn(`Corrupt/non-PDF detected for ${p.arxiv_id}; removing and re-downloading`);
        try { fs.rmSync(p.pdf_path, { force: true }); } catch {}
      }
      if (!pdfUrl) {
        console.warn(`No pdfUrl for ${p.arxiv_id}, skipping download`);
      } else {
        await sleep(jitter(1100, 2950));
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

console.log(`Artifacts done. Downloaded PDFs: ${downloaded}. Extracted txt: ${extracted}.`);
