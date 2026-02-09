import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { getUnscoredPapers, countScoredPapers, type UnscoredPaper } from '../lib/scoring/index.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const papersToScore = getUnscoredPapers(db);
const alreadyScored = countScoredPapers(db);

const prompt = `You are evaluating arXiv papers for relevance to a senior software engineer working on LLM-based agent systems, tool use, and AI engineering.

Rate this paper's relevance on a scale of 1-5:
1 = Not relevant (different field, keyword coincidence)
2 = Tangentially relevant (mentions relevant concepts but isn't about them)
3 = Somewhat relevant (related field, useful background)
4 = Relevant (directly about LLM agents, tool use, or AI engineering)
5 = Highly relevant (must-read for someone building LLM agent systems)

For each paper, respond with a JSON object: {"score": N, "reasoning": "one sentence explanation"}`;

interface ScorePlanOutput {
  kind: 'scorePlan';
  papersToScore: UnscoredPaper[];
  alreadyScored: number;
  prompt: string;
}

const output: ScorePlanOutput = {
  kind: 'scorePlan',
  papersToScore,
  alreadyScored,
  prompt,
};

console.log(JSON.stringify(output, null, 2));
