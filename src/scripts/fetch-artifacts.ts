// Step 3 runner: download PDFs + extract text for matched papers only.
// Useful when arXiv API is rate-limiting (429) and we still want to process backlog.

import fs from 'node:fs';
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

const res = await runArtifacts({ config, db });
console.log(
  `Artifacts done. Downloaded PDFs: ${res.downloadedPdfs}. Extracted txt: ${res.extractedTexts}. Corrupt re-downloads: ${res.corruptRedownloads}.`
);
