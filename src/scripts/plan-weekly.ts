import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { isoWeek, selectWeeklyPaper, getRelatedPapers } from '../lib/weekly/select.js';
import { hasWeeklyBeenSent, WEEKLY_SECTIONS, type WeeklyPlan } from '../lib/weekly/plan.js';
import { renderWeeklyHeaderMessage, renderQuietWeekMessage } from '../lib/weekly/render.js';
import { paperPaths } from '../lib/storage.js';
import { downloadToFile } from '../lib/download.js';
import { extractPdfToText } from '../lib/extract.js';

const PICK_FILE_PATH = '/root/.openclaw/state/arxiv-coach/weekly-pick.json';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

// Default to current week, but allow override via --week=2026-W07
const weekArg = process.argv.find(a => a.startsWith('--week='));
const weekIso = weekArg ? weekArg.split('=')[1]! : isoWeek(new Date());

const alreadySent = hasWeeklyBeenSent(db, weekIso);

// Select paper (respects pick file if exists)
const selected = selectWeeklyPaper(db, weekIso, PICK_FILE_PATH);

// Handle no papers case
if (!selected) {
  const quietMessage = renderQuietWeekMessage(weekIso);
  const plan: WeeklyPlan = {
    kind: 'weeklyPlan',
    weekIso: weekIso,
    alreadySent,
    selectedPaper: null,
    relatedPapers: [],
    sections: [],
    headerMessage: quietMessage.text,
  };
  console.log(JSON.stringify(plan));
  process.exit(0);
}

// Find paper's paths for artifacts
// Try to find the paper in the DB to get its stored paths
const paperRow = db.sqlite.prepare(
  'SELECT pdf_path, txt_path, updated_at FROM papers WHERE arxiv_id = ?'
).get(selected.arxivId) as { pdf_path: string; txt_path: string; updated_at: string } | undefined;

let textPath: string;
let hasFullText = false;

if (paperRow) {
  textPath = paperRow.txt_path;
  
  // Check if text exists
  if (fs.existsSync(textPath) && fs.statSync(textPath).size > 100) {
    hasFullText = true;
  } else {
    // Try to extract text from PDF if available
    const pdfPath = paperRow.pdf_path;
    if (fs.existsSync(pdfPath)) {
      try {
        extractPdfToText(pdfPath, textPath);
        if (fs.existsSync(textPath) && fs.statSync(textPath).size > 100) {
          hasFullText = true;
        }
      } catch {
        // Extraction failed, will use abstract only
      }
    } else {
      // No PDF, try to download it
      if (selected.pdfUrl) {
        try {
          await downloadToFile(selected.pdfUrl, pdfPath);
          extractPdfToText(pdfPath, textPath);
          if (fs.existsSync(textPath) && fs.statSync(textPath).size > 100) {
            hasFullText = true;
          }
        } catch {
          // Download or extraction failed
        }
      }
    }
  }
} else {
  // Paper not in DB with paths, compute them
  const paths = paperPaths(config.storage.root, selected.arxivId);
  textPath = paths.txtPath;
  
  if (fs.existsSync(textPath) && fs.statSync(textPath).size > 100) {
    hasFullText = true;
  }
}

// Get related papers
const relatedPapers = getRelatedPapers(db, weekIso, selected.arxivId, { maxRelated: 10 });

// Render header message
const headerResult = renderWeeklyHeaderMessage(weekIso!, {
  title: selected.title,
  absUrl: selected.absUrl,
  score: selected.score,
  tracks: selected.tracks,
  hasFullText,
});

const plan: WeeklyPlan = {
  kind: 'weeklyPlan',
  weekIso: weekIso,
  alreadySent,
  selectedPaper: {
    arxivId: selected.arxivId,
    title: selected.title,
    authors: selected.authors,
    abstract: selected.abstract,
    absUrl: selected.absUrl,
    pdfUrl: selected.pdfUrl,
    score: selected.score,
    tracks: selected.tracks,
    textPath,
    hasFullText,
  },
  relatedPapers,
  sections: [...WEEKLY_SECTIONS],
  headerMessage: headerResult.text,
};

console.log(JSON.stringify(plan));
