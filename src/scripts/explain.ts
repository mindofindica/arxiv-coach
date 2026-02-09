import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { lookupPaper, preparePaperText } from '../lib/explain/index.js';
import type { ExplainLevel, ExplainPlan } from '../lib/explain/types.js';

function parseArgs(args: string[]): { query: string; level: ExplainLevel } {
  let query = '';
  let level: ExplainLevel = 'engineer';
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    
    if (arg === '--level' && i + 1 < args.length) {
      const nextArg = args[i + 1]!;
      if (nextArg === 'eli12' || nextArg === 'undergrad' || nextArg === 'engineer') {
        level = nextArg;
      }
      i++;
    } else if (arg.startsWith('--level=')) {
      const val = arg.slice('--level='.length);
      if (val === 'eli12' || val === 'undergrad' || val === 'engineer') {
        level = val;
      }
    } else if (!arg.startsWith('-')) {
      query = arg;
    }
  }
  
  return { query, level };
}

async function main() {
  const args = process.argv.slice(2);
  const { query, level } = parseArgs(args);
  
  if (!query) {
    console.error('Usage: npm run explain -- "<query>" [--level eli12|undergrad|engineer]');
    process.exit(1);
  }
  
  const repoRoot = path.resolve(process.cwd());
  const config = loadConfig(repoRoot);
  const dbPath = path.join(config.storage.root, 'db.sqlite');
  const db = openDb(dbPath);
  migrate(db);
  
  // Step 1: Lookup paper
  const lookupResult = lookupPaper(db, query);
  
  if (lookupResult.status === 'not-found') {
    const plan: ExplainPlan = {
      kind: 'explainPlan',
      status: 'not-found',
      level,
      query,
    };
    console.log(JSON.stringify(plan));
    return;
  }
  
  if (lookupResult.status === 'ambiguous') {
    const plan: ExplainPlan = {
      kind: 'explainPlan',
      status: 'ambiguous',
      level,
      candidates: lookupResult.candidates?.map(c => ({
        arxivId: c.arxivId,
        title: c.title,
        score: c.score,
        tracks: c.tracks,
      })),
      query,
    };
    console.log(JSON.stringify(plan));
    return;
  }
  
  // Step 2: Prepare paper text
  const paper = lookupResult.paper!;
  const prepareResult = await preparePaperText(paper, config);
  
  if (prepareResult.status === 'no-text' || prepareResult.status === 'download-failed') {
    const plan: ExplainPlan = {
      kind: 'explainPlan',
      status: 'no-text',
      level,
      paper: {
        arxivId: paper.arxivId,
        title: paper.title,
        authors: paper.authors,
        abstract: paper.abstract,
        absUrl: paper.absUrl,
        textPath: prepareResult.textPath,
        hasFullText: false,
      },
      query,
    };
    console.log(JSON.stringify(plan));
    return;
  }
  
  // Step 3: Output ready plan
  const plan: ExplainPlan = {
    kind: 'explainPlan',
    status: 'ready',
    level,
    paper: {
      arxivId: paper.arxivId,
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      absUrl: paper.absUrl,
      textPath: prepareResult.textPath,
      hasFullText: prepareResult.hasFullText,
    },
    query,
  };
  console.log(JSON.stringify(plan));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
