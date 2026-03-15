/**
 * Slow artifact backfill — 3-6s jitter between downloads to avoid arxiv rate limits.
 * Targets matched papers missing PDFs or text files.
 */
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb, migrate } from '../lib/db.js';
import { ensureStorageRoot } from '../lib/repo.js';
import { runArtifacts } from '../lib/runners/artifacts.js';

const repoRoot = path.resolve(process.cwd());
const config = loadConfig(repoRoot);
ensureStorageRoot(config);
const db = openDb(path.join(config.storage.root, 'db.sqlite'));
migrate(db);

console.log('Starting slow artifact backfill (3–6s jitter)...');
const res = await runArtifacts({
  config,
  db,
  limit: 1440,
  jitterMs: { min: 3000, max: 6000 },
});
console.log(`Done. Downloaded: ${res.downloadedPdfs}, Extracted: ${res.extractedTexts}, Corrupt re-downloads: ${res.corruptRedownloads}, Skipped (no URL): ${res.skippedNoPdfUrl}`);
db.sqlite.close();
