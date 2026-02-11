import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { getByStatus, matchGapsToPlaper, buildLessonPrompt } from '../lib/gaps/index.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

// Get active gaps (identified or lesson_queued status)
const activeGaps = getByStatus(db, ['identified', 'lesson_queued']);

// Get recent papers (last 7 days) with title and abstract
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
const cutoffDate = sevenDaysAgo.toISOString();

const recentPapers = db.sqlite
  .prepare(
    `SELECT arxiv_id as arxivId, title, abstract
     FROM papers
     WHERE updated_at >= ?
     ORDER BY updated_at DESC`
  )
  .all(cutoffDate) as Array<{ arxivId: string; title: string; abstract: string }>;

// For each gap, check if any papers match
interface GapLessonPlan {
  gapId: string;
  concept: string;
  matchedPapers: Array<{
    arxivId: string;
    title: string;
    abstract: string;
    matchedIn: string[];
  }>;
  prompt: string;
}

const plans: GapLessonPlan[] = [];

for (const gap of activeGaps) {
  const matches: GapLessonPlan['matchedPapers'] = [];

  for (const paper of recentPapers) {
    const gapMatches = matchGapsToPlaper([gap], {
      title: paper.title,
      abstract: paper.abstract,
    });

    if (gapMatches.length > 0) {
      const match = gapMatches[0]!;
      matches.push({
        arxivId: paper.arxivId,
        title: paper.title,
        abstract: paper.abstract,
        matchedIn: match.matchedIn,
      });
    }
  }

  if (matches.length > 0) {
    // Use the first matched paper for the lesson prompt
    const primaryPaper = matches[0]!;
    const prompt = buildLessonPrompt(gap.concept, primaryPaper.title, primaryPaper.abstract);

    plans.push({
      gapId: gap.id,
      concept: gap.concept,
      matchedPapers: matches,
      prompt,
    });
  }
}

console.log(
  JSON.stringify({
    kind: 'gapLessonPlan',
    gaps: plans,
  })
);
