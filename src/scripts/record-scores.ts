import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { upsertScores, type LlmScore } from '../lib/scoring/index.js';

interface InputScore {
  arxivId: string;
  relevanceScore: number;
  reasoning: string;
  model: string;
}

interface InputFile {
  scores: InputScore[];
}

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('Usage: npm run record-scores -- <json-file-path>');
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.error(`File not found: ${jsonPath}`);
  process.exit(1);
}

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const input: InputFile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

if (!input.scores || !Array.isArray(input.scores)) {
  console.error('Invalid input: expected { scores: [...] }');
  process.exit(1);
}

const now = new Date().toISOString();
const scores: LlmScore[] = input.scores.map((s) => ({
  arxivId: s.arxivId,
  relevanceScore: s.relevanceScore,
  reasoning: s.reasoning || '',
  model: s.model || 'sonnet',
  scoredAt: now,
}));

upsertScores(db, scores);

console.log(JSON.stringify({
  kind: 'scoresRecorded',
  count: scores.length,
  arxivIds: scores.map((s) => s.arxivId),
}));
