import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { markDigestSent } from '../lib/notify/plan.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);

const planPath = process.argv[2];
if (!planPath) {
  throw new Error('Usage: tsx src/scripts/mark-sent.ts <plan.json>');
}

const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as {
  dateIso: string;
  header: string;
  tracks: Array<{ track: string; message: string }>;
  digestPath: string;
};

const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

markDigestSent(db, {
  dateIso: plan.dateIso,
  header: plan.header,
  tracks: plan.tracks,
  digestPath: plan.digestPath,
});

console.log(`Marked sent: ${plan.dateIso}`);
