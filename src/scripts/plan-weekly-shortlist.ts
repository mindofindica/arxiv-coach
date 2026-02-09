import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { isoWeek, selectWeeklyShortlist } from '../lib/weekly/select.js';
import { hasWeeklyBeenSent, type WeeklyShortlistPlan } from '../lib/weekly/plan.js';
import { renderShortlistMessage } from '../lib/weekly/render.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

// Default to current week, but allow override via --week=2026-W07
const weekArg = process.argv.find(a => a.startsWith('--week='));
const weekIso = weekArg ? weekArg.split('=')[1]! : isoWeek(new Date());

const alreadySent = hasWeeklyBeenSent(db, weekIso);
const candidates = selectWeeklyShortlist(db, weekIso, { maxCandidates: 3 });

const shortlistResult = renderShortlistMessage(weekIso, candidates);

const plan: WeeklyShortlistPlan = {
  kind: 'weeklyShortlist',
  weekIso: weekIso,
  alreadySent,
  candidates: candidates.map(c => ({
    rank: c.rank,
    arxivId: c.arxivId,
    title: c.title,
    score: c.score,
    tracks: c.tracks,
    absUrl: c.absUrl,
    abstract: c.abstract,
  })),
  shortlistMessage: shortlistResult.text,
};

console.log(JSON.stringify(plan));
