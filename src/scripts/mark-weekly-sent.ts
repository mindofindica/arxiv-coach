import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { markWeeklySent } from '../lib/weekly/plan.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

// Usage: tsx src/scripts/mark-weekly-sent.ts <weekIso> <arxivId> [sectionsJson]
const weekIso = process.argv[2];
const arxivId = process.argv[3];
const sectionsJson = process.argv[4] || '[]';

if (!weekIso || !arxivId) {
  console.error('Usage: tsx src/scripts/mark-weekly-sent.ts <weekIso> <arxivId> [sectionsJson]');
  console.error('Example: tsx src/scripts/mark-weekly-sent.ts 2026-W07 2602.01234');
  process.exit(1);
}

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

markWeeklySent(db, weekIso, arxivId, sectionsJson);

console.log(`Marked weekly sent: ${weekIso} (${arxivId})`);
