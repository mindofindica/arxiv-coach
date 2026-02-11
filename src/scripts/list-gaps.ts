import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { listGaps } from '../lib/gaps/index.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
const dbPath = path.join(config.storage.root, 'db.sqlite');
const db = openDb(dbPath);
migrate(db);

const gaps = listGaps(db);

console.log(
  JSON.stringify({
    kind: 'gapList',
    gaps: gaps.map((g) => ({
      id: g.id,
      concept: g.concept,
      status: g.status,
      priority: g.priority,
      createdAt: g.createdAt,
      paperTitle: g.paperTitle,
      arxivId: g.arxivId,
      tags: g.tags,
    })),
  })
);
