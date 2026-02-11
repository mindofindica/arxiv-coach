import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { createGap } from '../lib/gaps/index.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const concept = args[0];

  if (!concept) {
    console.error('Usage: npm run record-gap -- <concept> [--paper <arxivId>] [--context "..."]');
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    }
  }

  return { concept, flags };
}

const { concept, flags } = parseArgs();

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const gap = createGap(db, {
  concept,
  context: flags.context,
  sourceType: flags.paper ? 'paper' : 'manual',
  arxivId: flags.paper,
  detectionMethod: 'signal_command',
  originalMessage: `/gap ${concept}`,
  priority: 50,
});

console.log(
  JSON.stringify({
    kind: 'gapRecorded',
    id: gap.id,
    concept: gap.concept,
    paperTitle: gap.paperTitle,
    arxivId: gap.arxivId,
    status: gap.status,
    priority: gap.priority,
  })
);
